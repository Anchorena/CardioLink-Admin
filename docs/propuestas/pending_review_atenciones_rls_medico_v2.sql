-- CardioLink · Bloqueante 1 (v3.1 del borrador) — médico: mensajes internos y configuración saneada
-- BORRADOR PARA REVISIÓN. NO EJECUTAR en ningún entorno sin autorización explícita.
-- No está en supabase/migrations. Complementa pending_review_pendientes_medicos_v1.sql.
-- Antes de aplicar: guardar snapshot de pg_policies (staging_discovery_readonly.sql, consulta 6).
--
-- Base verificada en STAGING (yslhwdl…): el médico backend (professional_id = medico_qa_staging) NO existe en
-- config.usuarios. La identidad de mensajería sale del BACKEND (auth.uid() + professional_id), no de la config ni del email:
--   * Con usuarios configurados vinculados por profesionalId = mi professional_id -> sus logins (compatibles con
--     mensajes históricos `usuario:<login>` / deUsuario). Un médico puede tener varios.
--   * Sin ninguno -> login "seudónimo" = el propio professional_id (prefijo 'prof_' ante colisión con un login configurado).
-- Directorio del médico: sólo {destino, nombre, rol}. Config saneada: sin aranceles, reglasOS, pacientes ni otros usuarios.
-- Atenciones: sin cambios (aislamiento por profesional).
--
-- Rendimiento (v3.1): los predicados de mensajes son funciones PURAS (IMMUTABLE, sin SET ni SECURITY DEFINER => inlinables) y
-- reciben mis logins y mi uid como argumentos calculados UNA vez por consulta con `(SELECT ...)` (InitPlan), en lugar de
-- releer la fila de config (que contiene pacientes) por cada fila evaluada.
BEGIN;

-- Normalización equivalente a usuarioLoginCorto() del cliente. Pura: sin SET search_path para no bloquear el inlining.
CREATE OR REPLACE FUNCTION public.cardiolink_login_cliente_v1(p text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT pg_catalog.regexp_replace(
   pg_catalog.translate(pg_catalog.lower(pg_catalog.btrim(pg_catalog.split_part(coalesce(p,''),'@',1))),
                        'áàäâãéèëêíìïîóòöôõúùüûñç','aaaaaeeeeiiiiooooouuuunc'),
   '\s+','_','g')
$f$;

-- Usuarios activos de la config (helper interno; sin GRANT al cliente).
CREATE OR REPLACE FUNCTION public.cardiolink_config_usuarios_v1()
 RETURNS TABLE(login text, nombre text, rol text, prof text) LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT public.cardiolink_login_cliente_v1(coalesce(nullif(u->>'usuario',''),u->>'id')),
        u->>'nombre', u->>'rol', nullif(u->>'profesionalId','')
 FROM public.cardiolink_atenciones a,
      jsonb_array_elements(coalesce(a.payload#>'{config,usuarios}','[]'::jsonb)) u
 WHERE a.id='__cardiolink_config_v1' AND coalesce(u->>'activo','true')<>'false'
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_config_usuarios_v1() FROM PUBLIC;

-- Login seudónimo de un médico sin usuario configurado vinculado (a prueba de colisiones).
CREATE OR REPLACE FUNCTION public.cardiolink_login_seudonimo_v1(p_prof text)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT CASE WHEN EXISTS (SELECT 1 FROM public.cardiolink_config_usuarios_v1() c
                          WHERE c.login=public.cardiolink_login_cliente_v1(p_prof))
        THEN 'prof_' ELSE '' END || public.cardiolink_login_cliente_v1(p_prof)
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_login_seudonimo_v1(text) FROM PUBLIC;

-- Mis logins de mensajería ('{}' si no soy médico activo con professional_id). Se invoca UNA vez por consulta.
-- El primero es el "principal" que entrega la config saneada al cliente.
CREATE OR REPLACE FUNCTION public.cardiolink_logins_propios_v1()
 RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 WITH yo AS (
   SELECT r.professional_id AS prof FROM public.cardiolink_user_roles r
   WHERE r.user_id=auth.uid() AND r.active IS TRUE AND r.base_role='medico' AND nullif(btrim(r.professional_id),'') IS NOT NULL)
 SELECT CASE
   WHEN NOT EXISTS (SELECT 1 FROM yo) THEN '{}'::text[]            -- no médico: no toca la config
   WHEN EXISTS (SELECT 1 FROM public.cardiolink_config_usuarios_v1() c, yo WHERE c.prof=yo.prof)
     THEN (SELECT array_agg(DISTINCT c.login ORDER BY c.login) FROM public.cardiolink_config_usuarios_v1() c, yo WHERE c.prof=yo.prof)
   ELSE ARRAY[public.cardiolink_login_seudonimo_v1((SELECT prof FROM yo))]
 END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_logins_propios_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cardiolink_logins_propios_v1() TO authenticated;

-- Predicado PURO de lectura: ¿el médico (logins, uid) puede ver este mensaje? Sin logins => false (no es médico).
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
GRANT EXECUTE ON FUNCTION public.cardiolink_mensaje_visible_medico_v1(jsonb,text[],uuid) TO authenticated;

-- Predicado PURO de alta: sólo mensajes propios (creadoUid = yo) y con destino válido.
CREATE OR REPLACE FUNCTION public.cardiolink_mensaje_crea_medico_v1(p_payload jsonb, p_logins text[], p_uid uuid)
 RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT coalesce(pg_catalog.cardinality(p_logins),0)>0
  AND p_payload->>'tipoRegistro'='mensaje'
  AND p_payload->>'creadoUid' = p_uid::text
  AND coalesce(p_payload->>'destino','todos') ~ '^(todos|rol:secretaria|rol:medico|usuario:[a-z0-9_.-]+)$'
$f$;
GRANT EXECUTE ON FUNCTION public.cardiolink_mensaje_crea_medico_v1(jsonb,text[],uuid) TO authenticated;

-- Marcar leído: único cambio permitido al médico sobre un mensaje. Agrega TODOS sus logins a leidoPor
-- (si tiene varios usuarios configurados, cualquiera de ellos que resuelva el cliente queda como leído).
CREATE OR REPLACE FUNCTION public.cardiolink_mensaje_marcar_leido_v1(p_id text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE v_payload jsonb; v_logins text[]:=public.cardiolink_logins_propios_v1(); v_leidos jsonb; v_res jsonb; l text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sesión requerida'; END IF;
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
REVOKE ALL ON FUNCTION public.cardiolink_mensaje_marcar_leido_v1(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cardiolink_mensaje_marcar_leido_v1(text) TO authenticated;

-- Directorio mínimo (cualquier rol activo): SÓLO destino interno, nombre visible y rol.
-- Incluye los usuarios activos de la config y los médicos del backend sin usuario configurado vinculado.
CREATE OR REPLACE FUNCTION public.cardiolink_directorio_mensajes_v1()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT CASE WHEN EXISTS (SELECT 1 FROM public.cardiolink_user_roles r WHERE r.user_id=auth.uid() AND r.active IS TRUE)
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
     WHERE r.active IS TRUE AND r.base_role='medico' AND nullif(btrim(r.professional_id),'') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.cardiolink_config_usuarios_v1() c WHERE c.prof=r.professional_id)
   ) d),'[]'::jsonb)
 ELSE NULL END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_directorio_mensajes_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cardiolink_directorio_mensajes_v1() TO authenticated;

-- Configuración clínica saneada (sólo médicos): profesionales (id, nombre, área, prestaciones), obras sociales,
-- SU usuario configurado (si existe; determinista) y su identidad de mensajería. Sin aranceles, reglasOS, pacientes
-- ni otros usuarios.
CREATE OR REPLACE FUNCTION public.cardiolink_config_medico_v1()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT CASE WHEN EXISTS (SELECT 1 FROM public.cardiolink_user_roles r WHERE r.user_id=auth.uid() AND r.active IS TRUE AND r.base_role='medico')
 THEN jsonb_build_object(
   'profesionales', coalesce((SELECT jsonb_agg(jsonb_build_object('id',p->'id','nombre',p->'nombre','area',p->'area','prestaciones',p->'prestaciones'))
        FROM public.cardiolink_atenciones a, jsonb_array_elements(coalesce(a.payload#>'{config,profesionales}','[]'::jsonb)) p
        WHERE a.id='__cardiolink_config_v1'),'[]'::jsonb),
   'obrasSociales', coalesce((SELECT a.payload#>'{config,obrasSociales}' FROM public.cardiolink_atenciones a WHERE a.id='__cardiolink_config_v1'),'[]'::jsonb),
   'usuarioPropio', (SELECT u FROM public.cardiolink_atenciones a, jsonb_array_elements(coalesce(a.payload#>'{config,usuarios}','[]'::jsonb)) u,
                          public.cardiolink_user_roles r
                     WHERE a.id='__cardiolink_config_v1' AND r.user_id=auth.uid() AND r.active IS TRUE AND r.base_role='medico'
                       AND nullif(u->>'profesionalId','')=r.professional_id AND coalesce(u->>'activo','true')<>'false'
                     ORDER BY u->>'usuario', u->>'id' LIMIT 1),
   'mensajeria', jsonb_build_object('login',(public.cardiolink_logins_propios_v1())[1]))
 ELSE NULL END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_config_medico_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cardiolink_config_medico_v1() TO authenticated;

-- Políticas: atenciones SIN cambios para el médico; se suma lectura/alta de mensajes autorizados.
-- (SELECT ...) fuerza InitPlan: mis logins y mi uid se calculan una vez por consulta, no por fila.
DROP POLICY IF EXISTS cardiolink_atenciones_select ON public.cardiolink_atenciones;
DROP POLICY IF EXISTS cardiolink_atenciones_insert ON public.cardiolink_atenciones;
CREATE POLICY cardiolink_atenciones_select ON public.cardiolink_atenciones FOR SELECT TO authenticated
  USING (public.cardiolink_permite_atencion_v1(payload)
         OR (payload->>'tipoRegistro'='mensaje'
             AND public.cardiolink_mensaje_visible_medico_v1(payload,(SELECT public.cardiolink_logins_propios_v1()),(SELECT auth.uid()))));
CREATE POLICY cardiolink_atenciones_insert ON public.cardiolink_atenciones FOR INSERT TO authenticated
  WITH CHECK (public.cardiolink_permite_atencion_v1(payload)
         OR public.cardiolink_mensaje_crea_medico_v1(payload,(SELECT public.cardiolink_logins_propios_v1()),(SELECT auth.uid())));
-- update/delete: sin cambios (el médico no modifica ni borra mensajes ni config; marca leído por RPC).

-- Rollback: restaurar select/insert de pending_review_pendientes_medicos_v1.sql y retirar estas funciones
-- sólo después de retirar el frontend que las llama.
COMMIT;
