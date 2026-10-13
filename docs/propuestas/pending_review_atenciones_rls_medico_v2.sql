-- CardioLink · Bloqueante 1 (v3.2 del borrador) — médico: mensajes internos y configuración saneada
-- BORRADOR PARA REVISIÓN. NO EJECUTAR en ningún entorno sin autorización explícita.
-- No está en supabase/migrations. Complementa pending_review_pendientes_medicos_v1.sql (ya reflejada en STAGING).
-- Rollback exacto a las políticas previas de STAGING: pending_review_atenciones_rls_medico_v2_rollback.sql
-- Antes de aplicar: guardar snapshot de pg_policies y de routine_privileges (staging_discovery_readonly.sql, consultas 6 y 7).
--
-- Cambios v3.2 (revisión de ChatGPT sobre v3.1):
--  1. cardiolink_config_medico_v1 construye EXPLÍCITAMENTE el JSON de `usuarioPropio` (id, usuario, nombre, rol,
--     profesionalId, especialidad, activo + a lo sumo el alias del propio login para que el cliente pueda reconocerse).
--     No devuelve aliases completos, email, rolId, soloMatias ni otros campos internos.
--  2. Identidad médica exigida en un único lugar (cardiolink_ctx_prof_v1): sesión autenticada + rol médico ACTIVO +
--     professional_id válido (^[A-Za-z0-9_.-]{1,64}$). Si falla algo => sin config médica, sin logins, sin mensajes.
--  3. HALLAZGO propio: con la política anterior un médico podía insertar una "atención" propia con tipoRegistro='mensaje'
--     (o 'config') y así falsificar un mensaje saltándose creadoUid. Las 4 políticas pasan a un predicado v2 que, para el
--     médico, EXCLUYE tipoRegistro mensaje/config. UPDATE/DELETE de mensajes y config siguen bloqueados para médicos.
--  4. GRANTs: en Supabase REVOKE ... FROM PUBLIC no quita el EXECUTE por defecto de anon/authenticated. Se revoca
--     explícitamente de PUBLIC y anon (y de authenticated en helpers internos). Verificar con la consulta 7 del discovery.
--  5. Precondición: la migración aborta si las políticas actuales no son las esperadas (STAGING = permite_atencion_v1).
--  6. (v3.2.1) cardiolink_mensaje_crea_medico_v1 exige ADEMÁS que deUsuario (normalizado) pertenezca a MIS logins verificados:
--     un médico no puede enviar con creadoUid propio y el remitente de otro profesional. deNombre/creadoPor/creadoUsuario son
--     etiquetas de pantalla enviadas por el cliente y NUNCA se usan para decidir identidad ni permisos.
--
-- Base verificada en STAGING (yslhwdl…): el médico backend (professional_id = medico_qa_staging) NO existe en config.usuarios.
-- La identidad de mensajería sale del BACKEND, no de la config ni del email:
--   * Con usuarios configurados vinculados por profesionalId = mi professional_id -> sus logins (compatibles con mensajes
--     históricos `usuario:<login>` / deUsuario). Un médico puede tener varios.
--   * Sin ninguno -> login "seudónimo" = el propio professional_id (prefijo 'prof_' ante colisión).
-- Directorio del médico: sólo {destino, nombre, rol}. Atenciones: aislamiento por profesional intacto.
-- Rendimiento: predicados PUROS (IMMUTABLE, sin SET ni SECURITY DEFINER, sin subconsultas => inlinables) que reciben
-- rol/prof/logins/uid calculados UNA vez por consulta con `(SELECT ...)` (InitPlan).
BEGIN;

-- ===== 0) Precondición: estado previo esperado de las políticas (aborta si STAGING difiere) =====
CREATE TEMP TABLE _chk_mensajes ON COMMIT DROP AS
  SELECT count(*)::bigint AS antes FROM public.cardiolink_atenciones WHERE payload->>'tipoRegistro'='mensaje';
DO $$
DECLARE n int; bad int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE NOT (
           permissive='PERMISSIVE' AND roles::text[]=ARRAY['authenticated']
       AND ( (cmd IN ('SELECT','DELETE') AND coalesce(qual,'') ~ 'cardiolink_permite_atencion_v1\(payload\)')
          OR (cmd='INSERT' AND coalesce(with_check,'') ~ 'cardiolink_permite_atencion_v1\(payload\)')
          OR (cmd='UPDATE' AND coalesce(qual,'') ~ 'cardiolink_permite_atencion_v1\(payload\)'
                          AND coalesce(with_check,'') ~ 'cardiolink_permite_atencion_v1\(payload\)') )))
    INTO n, bad
  FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones';
  IF n<>4 THEN RAISE EXCEPTION 'Precondición: se esperaban 4 políticas en cardiolink_atenciones, hay % (revisar snapshot)', n; END IF;
  IF bad>0 THEN RAISE EXCEPTION 'Precondición: % política(s) no coinciden con permite_atencion_v1 para authenticated (revisar snapshot)', bad; END IF;
END $$;

-- ===== 1) Utilidades puras =====
CREATE OR REPLACE FUNCTION public.cardiolink_login_cliente_v1(p text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT pg_catalog.regexp_replace(
   pg_catalog.translate(pg_catalog.lower(pg_catalog.btrim(pg_catalog.split_part(coalesce(p,''),'@',1))),
                        'áàäâãéèëêíìïîóòöôõúùüûñç','aaaaaeeeeiiiiooooouuuunc'),
   '\s+','_','g')
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_login_cliente_v1(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_login_cliente_v1(text) TO authenticated;  -- lo evalúan las políticas

-- Predicado de atención v2 (PURO): globales ven todo; el médico sólo SUS atenciones y nunca filas de mensaje/config.
CREATE OR REPLACE FUNCTION public.cardiolink_atencion_permitida_v2(p_payload jsonb, p_rol text, p_prof text)
 RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT CASE
   WHEN p_rol IN ('owner','admin','secretaria') THEN true
   WHEN p_rol = 'medico' THEN nullif(pg_catalog.btrim(p_prof),'') IS NOT NULL
        AND p_prof = p_payload->>'profesionalId'
        AND coalesce(p_payload->>'tipoRegistro','') NOT IN ('mensaje','config')
   ELSE false END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_atencion_permitida_v2(jsonb,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_atencion_permitida_v2(jsonb,text,text) TO authenticated;

-- ===== 2) Contexto del llamador (una consulta por función; se invocan como InitPlan) =====
CREATE OR REPLACE FUNCTION public.cardiolink_ctx_rol_v1()
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT r.base_role FROM public.cardiolink_user_roles r
 WHERE auth.uid() IS NOT NULL AND r.user_id=auth.uid() AND r.active IS TRUE
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_ctx_rol_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_ctx_rol_v1() TO authenticated;

-- Identidad médica: sesión + rol médico activo + professional_id válido. NULL si falla cualquiera.
CREATE OR REPLACE FUNCTION public.cardiolink_ctx_prof_v1()
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT r.professional_id FROM public.cardiolink_user_roles r
 WHERE auth.uid() IS NOT NULL AND r.user_id=auth.uid() AND r.active IS TRUE AND r.base_role='medico'
   AND r.professional_id ~ '^[A-Za-z0-9_.-]{1,64}$'
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_ctx_prof_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_ctx_prof_v1() TO authenticated;

-- ===== 3) Helpers internos de configuración (SIN acceso del cliente) =====
CREATE OR REPLACE FUNCTION public.cardiolink_config_usuarios_v1()
 RETURNS TABLE(login text, nombre text, rol text, prof text) LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT public.cardiolink_login_cliente_v1(coalesce(nullif(u->>'usuario',''),nullif(u->>'email',''),u->>'id')),   -- igual que normalizarUsuarioRegistro() del cliente
        u->>'nombre', u->>'rol', nullif(u->>'profesionalId','')
 FROM public.cardiolink_atenciones a,
      jsonb_array_elements(coalesce(a.payload#>'{config,usuarios}','[]'::jsonb)) u
 WHERE a.id='__cardiolink_config_v1' AND coalesce(u->>'activo','true')<>'false'
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_config_usuarios_v1() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cardiolink_login_seudonimo_v1(p_prof text)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT CASE WHEN EXISTS (SELECT 1 FROM public.cardiolink_config_usuarios_v1() c
                          WHERE c.login=public.cardiolink_login_cliente_v1(p_prof))
        THEN 'prof_' ELSE '' END || public.cardiolink_login_cliente_v1(p_prof)
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_login_seudonimo_v1(text) FROM PUBLIC, anon, authenticated;

-- Mis logins de mensajería ('{}' si la identidad médica no es válida). Se invoca UNA vez por consulta.
CREATE OR REPLACE FUNCTION public.cardiolink_logins_propios_v1()
 RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT CASE
   WHEN public.cardiolink_ctx_prof_v1() IS NULL THEN '{}'::text[]        -- no médico válido: no toca la config
   WHEN EXISTS (SELECT 1 FROM public.cardiolink_config_usuarios_v1() c WHERE c.prof=public.cardiolink_ctx_prof_v1())
     THEN (SELECT array_agg(DISTINCT c.login ORDER BY c.login)
           FROM public.cardiolink_config_usuarios_v1() c WHERE c.prof=public.cardiolink_ctx_prof_v1())
   ELSE ARRAY[public.cardiolink_login_seudonimo_v1(public.cardiolink_ctx_prof_v1())]
 END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_logins_propios_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_logins_propios_v1() TO authenticated;

-- ===== 4) Predicados PUROS de mensajes =====
CREATE OR REPLACE FUNCTION public.cardiolink_mensaje_visible_medico_v1(p_payload jsonb, p_logins text[], p_uid uuid)
 RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT coalesce(pg_catalog.cardinality(p_logins),0)>0
  AND p_payload->>'tipoRegistro'='mensaje'
  AND ( coalesce(p_payload->>'destino','todos') IN ('todos','rol:medico')
     OR (p_payload->>'destino' LIKE 'usuario:%' AND pg_catalog.substr(p_payload->>'destino',9) = ANY (p_logins))
     OR p_payload->>'creadoUid' = p_uid::text
     OR (p_payload->>'creadoUid' IS NULL
         AND public.cardiolink_login_cliente_v1(p_payload->>'deUsuario') = ANY (p_logins)) )
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_mensaje_visible_medico_v1(jsonb,text[],uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_mensaje_visible_medico_v1(jsonb,text[],uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.cardiolink_mensaje_crea_medico_v1(p_payload jsonb, p_logins text[], p_uid uuid)
 RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT coalesce(pg_catalog.cardinality(p_logins),0)>0
  AND p_payload->>'tipoRegistro'='mensaje'
  AND p_payload->>'creadoUid' = p_uid::text
  -- El remitente declarado debe ser un login PROPIO verificado por el backend (nunca el de otro profesional).
  AND public.cardiolink_login_cliente_v1(p_payload->>'deUsuario') = ANY (p_logins)
  AND coalesce(p_payload->>'destino','todos') ~ '^(todos|rol:secretaria|rol:medico|usuario:[a-z0-9_.-]+)$'
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_mensaje_crea_medico_v1(jsonb,text[],uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_mensaje_crea_medico_v1(jsonb,text[],uuid) TO authenticated;

-- ===== 5) RPC para el cliente =====
-- Marcar leído: único cambio permitido al médico sobre un mensaje. Agrega TODOS sus logins a leidoPor.
CREATE OR REPLACE FUNCTION public.cardiolink_mensaje_marcar_leido_v1(p_id text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE v_payload jsonb; v_logins text[]:=public.cardiolink_logins_propios_v1(); v_leidos jsonb; v_res jsonb; l text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sesión requerida'; END IF;
  IF coalesce(array_length(v_logins,1),0)=0 THEN RAISE EXCEPTION 'Identidad médica no válida'; END IF;
  SELECT payload INTO v_payload FROM public.cardiolink_atenciones WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_payload->>'tipoRegistro' IS DISTINCT FROM 'mensaje' THEN RAISE EXCEPTION 'Mensaje inexistente'; END IF;
  IF NOT public.cardiolink_mensaje_visible_medico_v1(v_payload, v_logins, auth.uid()) THEN RAISE EXCEPTION 'Mensaje no autorizado'; END IF;
  v_leidos := CASE WHEN jsonb_typeof(v_payload->'leidoPor')='array' THEN v_payload->'leidoPor' ELSE '[]'::jsonb END;
  FOREACH l IN ARRAY v_logins LOOP
    IF NOT (v_leidos ? l) THEN v_leidos := v_leidos || to_jsonb(l); END IF;
  END LOOP;
  v_res := jsonb_set(v_payload,'{leidoPor}',v_leidos,true);
  UPDATE public.cardiolink_atenciones SET payload=v_res, updated_at=clock_timestamp() WHERE id=p_id;
  RETURN v_res;
END $f$;
REVOKE ALL ON FUNCTION public.cardiolink_mensaje_marcar_leido_v1(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_mensaje_marcar_leido_v1(text) TO authenticated;

-- Directorio mínimo (cualquier rol activo con sesión): SÓLO destino interno, nombre visible y rol.
CREATE OR REPLACE FUNCTION public.cardiolink_directorio_mensajes_v1()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT CASE WHEN public.cardiolink_ctx_rol_v1() IS NOT NULL
 THEN coalesce((
   SELECT jsonb_agg(jsonb_build_object('destino',d.destino,'nombre',d.nombre,'rol',d.rol) ORDER BY d.nombre)
   FROM (
     SELECT 'usuario:'||c.login AS destino, coalesce(c.nombre,c.login) AS nombre, coalesce(c.rol,'') AS rol
     FROM public.cardiolink_config_usuarios_v1() c
     UNION ALL
     SELECT 'usuario:'||public.cardiolink_login_seudonimo_v1(r.professional_id),
            coalesce((SELECT p->>'nombre' FROM public.cardiolink_atenciones a,
                        jsonb_array_elements(coalesce(a.payload#>'{config,profesionales}','[]'::jsonb)) p
                      WHERE a.id='__cardiolink_config_v1' AND p->>'id'=r.professional_id LIMIT 1),
                     'Médico '||r.professional_id),
            'medico'
     FROM public.cardiolink_user_roles r
     WHERE r.active IS TRUE AND r.base_role='medico' AND r.professional_id ~ '^[A-Za-z0-9_.-]{1,64}$'
       AND NOT EXISTS (SELECT 1 FROM public.cardiolink_config_usuarios_v1() c WHERE c.prof=r.professional_id)
   ) d),'[]'::jsonb)
 ELSE NULL END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_directorio_mensajes_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_directorio_mensajes_v1() TO authenticated;

-- Configuración clínica saneada (sólo identidad médica válida). JSON de usuarioPropio construido CAMPO A CAMPO.
CREATE OR REPLACE FUNCTION public.cardiolink_config_medico_v1()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT CASE WHEN public.cardiolink_ctx_prof_v1() IS NOT NULL
 THEN jsonb_build_object(
   'profesionales', coalesce((SELECT jsonb_agg(jsonb_build_object('id',p->'id','nombre',p->'nombre','area',p->'area','prestaciones',p->'prestaciones'))
        FROM public.cardiolink_atenciones a, jsonb_array_elements(coalesce(a.payload#>'{config,profesionales}','[]'::jsonb)) p
        WHERE a.id='__cardiolink_config_v1'),'[]'::jsonb),
   'obrasSociales', coalesce((SELECT a.payload#>'{config,obrasSociales}' FROM public.cardiolink_atenciones a WHERE a.id='__cardiolink_config_v1'),'[]'::jsonb),
   'usuarioPropio', (
     SELECT jsonb_strip_nulls(jsonb_build_object(
              'id', u->>'id', 'usuario', u->>'usuario', 'nombre', u->>'nombre', 'rol', u->>'rol',
              'profesionalId', u->>'profesionalId', 'especialidad', u->>'especialidad', 'activo', u->'activo',
              -- sólo el alias que coincide con el login del propio llamador (para que el cliente se reconozca); nunca la lista
              'aliases', CASE WHEN me.l <> '' AND (me.l IN (public.cardiolink_login_cliente_v1(u->>'usuario'), public.cardiolink_login_cliente_v1(u->>'id'),
                                                          public.cardiolink_login_cliente_v1(u->>'email'))
                                                  OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(u->'aliases','[]'::jsonb)) al
                                                             WHERE public.cardiolink_login_cliente_v1(al)=me.l))
                              THEN jsonb_build_array(me.l) END))
     FROM public.cardiolink_atenciones a,
          jsonb_array_elements(coalesce(a.payload#>'{config,usuarios}','[]'::jsonb)) u,
          (SELECT public.cardiolink_login_cliente_v1(auth.jwt()->>'email') AS l) me
     WHERE a.id='__cardiolink_config_v1'
       AND nullif(u->>'profesionalId','')=public.cardiolink_ctx_prof_v1()
       AND u->>'rol'='medico' AND coalesce(u->>'activo','true')<>'false'
     ORDER BY u->>'usuario', u->>'id' LIMIT 1),
   'mensajeria', jsonb_build_object('login',(public.cardiolink_logins_propios_v1())[1]))
 ELSE NULL END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_config_medico_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_config_medico_v1() TO authenticated;

-- ===== 6) Políticas (las 4). Rol/prof/logins/uid se calculan una vez por consulta (InitPlan). =====
DROP POLICY IF EXISTS cardiolink_atenciones_select ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_insert ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_update ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_delete ON public.cardiolink_atenciones;
CREATE POLICY cardiolink_atenciones_select ON public.cardiolink_atenciones FOR SELECT TO authenticated
  USING (public.cardiolink_atencion_permitida_v2(payload,(SELECT public.cardiolink_ctx_rol_v1()),(SELECT public.cardiolink_ctx_prof_v1()))
         OR (payload->>'tipoRegistro'='mensaje'
             AND public.cardiolink_mensaje_visible_medico_v1(payload,(SELECT public.cardiolink_logins_propios_v1()),(SELECT auth.uid()))));
CREATE POLICY cardiolink_atenciones_insert ON public.cardiolink_atenciones FOR INSERT TO authenticated
  WITH CHECK (public.cardiolink_atencion_permitida_v2(payload,(SELECT public.cardiolink_ctx_rol_v1()),(SELECT public.cardiolink_ctx_prof_v1()))
         OR public.cardiolink_mensaje_crea_medico_v1(payload,(SELECT public.cardiolink_logins_propios_v1()),(SELECT auth.uid())));
-- UPDATE/DELETE: SÓLO el predicado de atención v2 => el médico no modifica ni borra mensajes ni config
-- (marca leído por RPC) y no puede reconvertir una atención propia en mensaje/config.
CREATE POLICY cardiolink_atenciones_update ON public.cardiolink_atenciones FOR UPDATE TO authenticated
  USING (public.cardiolink_atencion_permitida_v2(payload,(SELECT public.cardiolink_ctx_rol_v1()),(SELECT public.cardiolink_ctx_prof_v1())))
  WITH CHECK (public.cardiolink_atencion_permitida_v2(payload,(SELECT public.cardiolink_ctx_rol_v1()),(SELECT public.cardiolink_ctx_prof_v1())));
CREATE POLICY cardiolink_atenciones_delete ON public.cardiolink_atenciones FOR DELETE TO authenticated
  USING (public.cardiolink_atencion_permitida_v2(payload,(SELECT public.cardiolink_ctx_rol_v1()),(SELECT public.cardiolink_ctx_prof_v1())));

-- ===== 7) Postcondición: los mensajes históricos se conservan (esta migración no hace DML) =====
DO $$
DECLARE antes bigint; despues bigint;
BEGIN
  SELECT t.antes INTO antes FROM _chk_mensajes t;
  SELECT count(*) INTO despues FROM public.cardiolink_atenciones WHERE payload->>'tipoRegistro'='mensaje';
  IF antes IS DISTINCT FROM despues THEN RAISE EXCEPTION 'Postcondición: cambió la cantidad de mensajes (% -> %)', antes, despues; END IF;
END $$;

COMMIT;
