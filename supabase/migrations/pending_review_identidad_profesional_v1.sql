-- CardioLink · Identidad profesional V1 — persistencia de la identidad documental por una RPC específica
-- MIGRACIÓN PENDIENTE DE REVISIÓN. NO EJECUTAR sin autorización explícita. Primero STAGING; Production sólo después del QA de STAGING.
-- Merge de Git NO instala estas funciones. El nombre "pending_review_*" es a propósito: la CLI de Supabase ignora archivos sin
-- prefijo de timestamp, así que `supabase db push` no puede aplicarla por accidente. Al aplicarla de verdad se renombra con timestamp.
-- Rollback: pending_review_identidad_profesional_v1_rollback.sql. Checks de sólo lectura: docs/propuestas/pending_review_identidad_profesional_v1_checks.sql.
-- Pruebas SQL (STAGING, transacción con ROLLBACK): docs/propuestas/pending_review_identidad_profesional_v1_tests.sql.
--
-- PROBLEMA. La identidad documental de cada profesional (marca, logo, firma, matrículas, contacto, color) vive dentro de la fila
-- técnica __cardiolink_config_v1 de cardiolink_atenciones (payload.config.profesionales[]). El médico NUNCA escribe esa fila
-- (correcto: protege la configuración global), pero tampoco existía otra vía: lo que un médico "guardaba" se perdía al refrescar o
-- al cambiar de equipo. Además cardiolink_config_medico_v1() no devolvía la identidad documental.
--
-- QUÉ HACE (y nada más):
--   1) crea public.cardiolink_guardar_identidad_profesional_v1(p_professional_id text, p_identity jsonb) -> jsonb
--      SECURITY DEFINER; la autorización se decide SÓLO en el servidor con cardiolink_user_roles + auth.uid():
--        owner / admin : cualquier profesional existente de la configuración (hay un único consultorio/config);
--        medico        : únicamente el profesional cuyo id coincide con su propio professional_id;
--        secretaria u otro rol, sesión inexistente o rol inactivo: rechazado.
--      Bloquea la fila de config (FOR UPDATE) y modifica SOLAMENTE esas 12 claves del objeto de ese profesional:
--        marcaDocumento logoDocumento logoDocumentoData firmaDocumentoData matriculaNacional matriculaProvincial telefonoDocumento
--        emailDocumento direccionDocumento redesDocumento colorDocumento mostrarFirmaDocumento
--      Una clave omitida conserva su valor; '' borra (logo/firma/dato); cualquier otra clave => error. Devuelve la identidad persistida.
--   2) amplía cardiolink_config_medico_v1(): para el médico, SU PROPIO profesional (y sólo ese) incluye además esas 12 claves.
--      El resto del contenido de la función queda igual (id/nombre/area/prestaciones, obrasSociales, usuarioPropio, mensajeria).
--
-- NO modifica: datos existentes, políticas RLS, tablas, Storage, Edge Functions ni ninguna otra función. No agrega columnas.
-- GRANT: EXECUTE sólo a authenticated; REVOKE a PUBLIC/anon.

BEGIN;

-- 0) Precondiciones: aborta (sin cambios) si el esquema no es el esperado o si ya se aplicó.
DO $$
DECLARE v_src text;
BEGIN
  IF to_regclass('public.cardiolink_user_roles') IS NULL OR to_regclass('public.cardiolink_atenciones') IS NULL THEN
    RAISE EXCEPTION 'Faltan cardiolink_user_roles o cardiolink_atenciones';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND table_name='cardiolink_user_roles'
         AND column_name IN ('user_id','base_role','professional_id','active')) <> 4 THEN
    RAISE EXCEPTION 'cardiolink_user_roles no tiene user_id/base_role/professional_id/active';
  END IF;
  IF to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN
    RAISE EXCEPTION 'Falta cardiolink_ctx_prof_v1(): aplicar antes pending_review_atenciones_rls_medico_v2.sql';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='cardiolink_config_medico_v1' AND pg_get_function_identity_arguments(p.oid)='';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'Falta cardiolink_config_medico_v1(): aplicar antes pending_review_atenciones_rls_medico_v2.sql';
  END IF;
  IF position('usuarioPropio' IN v_src)=0 OR position('mensajeria' IN v_src)=0 OR position('obrasSociales' IN v_src)=0
     OR position('''prestaciones'',p->''prestaciones''' IN v_src)=0 THEN
    RAISE EXCEPTION 'cardiolink_config_medico_v1() difiere de la versión esperada (v3.2): comparar con docs/propuestas/pending_review_identidad_profesional_v1_checks.sql antes de continuar';
  END IF;
  IF position('logoDocumentoData' IN v_src)>0 THEN
    RAISE EXCEPTION 'cardiolink_config_medico_v1() ya incluye la identidad documental: la migración ya fue aplicada';
  END IF;
  IF to_regprocedure('public.cardiolink_guardar_identidad_profesional_v1(text,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'Ya existe cardiolink_guardar_identidad_profesional_v1(text,jsonb): no se repite';
  END IF;
END $$;

-- 1) RPC de escritura de la identidad profesional.
CREATE FUNCTION public.cardiolink_guardar_identidad_profesional_v1(p_professional_id text, p_identity jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  c_row_id  constant text   := '__cardiolink_config_v1';
  c_texto   constant text[] := ARRAY['marcaDocumento','logoDocumento','logoDocumentoData','firmaDocumentoData','matriculaNacional',
                                     'matriculaProvincial','telefonoDocumento','emailDocumento','direccionDocumento','redesDocumento',
                                     'colorDocumento'];
  c_campos  constant text[] := ARRAY['marcaDocumento','logoDocumento','logoDocumentoData','firmaDocumentoData','matriculaNacional',
                                     'matriculaProvincial','telefonoDocumento','emailDocumento','direccionDocumento','redesDocumento',
                                     'colorDocumento','mostrarFirmaDocumento'];
  v_uid     uuid := auth.uid();
  v_rol     text;
  v_prof    text;
  v_extra   text;
  v_k       text;
  v_t       text;
  v_payload jsonb;
  v_pos     int;
  v_actual  jsonb;
  v_nuevo   jsonb;
  v_ident   jsonb;
  v_upd     timestamptz;
BEGIN
  -- Autorización: SÓLO backend (sesión + rol activo en cardiolink_user_roles). Nada de lo que envía el cliente decide permisos.
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Sesión requerida' USING ERRCODE='28000'; END IF;
  SELECT r.base_role, r.professional_id INTO v_rol, v_prof
    FROM public.cardiolink_user_roles r WHERE r.user_id=v_uid AND r.active IS TRUE;
  IF v_rol IS NULL THEN RAISE EXCEPTION 'Rol no autorizado' USING ERRCODE='42501'; END IF;
  IF p_professional_id IS NULL OR p_professional_id !~ '^[A-Za-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'Profesional inválido' USING ERRCODE='22023';
  END IF;
  IF v_rol IN ('owner','admin') THEN
    NULL;
  ELSIF v_rol='medico' THEN
    IF v_prof IS NULL OR v_prof !~ '^[A-Za-z0-9_.-]{1,64}$' OR v_prof <> p_professional_id THEN
      RAISE EXCEPTION 'Un médico sólo puede modificar su propia identidad profesional' USING ERRCODE='42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Tu rol no puede modificar la identidad profesional' USING ERRCODE='42501';
  END IF;

  -- Validación del contenido: sólo las 12 claves permitidas, con tipo y forma válidos.
  IF p_identity IS NULL OR jsonb_typeof(p_identity)<>'object' THEN
    RAISE EXCEPTION 'La identidad debe ser un objeto JSON' USING ERRCODE='22023';
  END IF;
  SELECT string_agg(k, ', ') INTO v_extra FROM jsonb_object_keys(p_identity) AS k WHERE k <> ALL (c_campos);
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'Campos no permitidos en la identidad: %', v_extra USING ERRCODE='22023';
  END IF;
  FOREACH v_k IN ARRAY c_campos LOOP
    CONTINUE WHEN NOT (p_identity ? v_k);
    IF v_k='mostrarFirmaDocumento' THEN
      IF jsonb_typeof(p_identity->v_k)<>'boolean' THEN RAISE EXCEPTION 'mostrarFirmaDocumento debe ser booleano' USING ERRCODE='22023'; END IF;
    ELSE
      IF jsonb_typeof(p_identity->v_k)<>'string' THEN RAISE EXCEPTION '% debe ser texto (usar "" para borrar)', v_k USING ERRCODE='22023'; END IF;
      v_t := p_identity->>v_k;
      IF v_k IN ('logoDocumentoData','firmaDocumentoData') THEN
        IF v_t <> '' AND (v_t !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' OR char_length(v_t) > 1500000) THEN
          RAISE EXCEPTION '% debe ser una imagen png/jpeg/webp en base64 de hasta 1,5 M de caracteres, o vacío', v_k USING ERRCODE='22023';
        END IF;
      ELSIF v_k='colorDocumento' THEN
        IF v_t !~ '^#[0-9A-Fa-f]{6}$' THEN RAISE EXCEPTION 'colorDocumento debe ser #RRGGBB' USING ERRCODE='22023'; END IF;
      ELSIF v_k='logoDocumento' THEN
        IF char_length(v_t) > 2048 OR v_t ~* '^\s*(javascript:|vbscript:|data:(?!image/))' THEN
          RAISE EXCEPTION 'logoDocumento no es una ruta o URL válida' USING ERRCODE='22023';
        END IF;
      ELSIF char_length(v_t) > 1000 THEN
        RAISE EXCEPTION '% supera 1000 caracteres', v_k USING ERRCODE='22023';
      END IF;
    END IF;
  END LOOP;

  -- Fila de configuración: bloqueo para no pisar cambios concurrentes.
  SELECT a.payload INTO v_payload FROM public.cardiolink_atenciones a WHERE a.id=c_row_id FOR UPDATE;
  IF v_payload IS NULL OR jsonb_typeof(v_payload #> '{config,profesionales}') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Configuración de profesionales no disponible' USING ERRCODE='P0002';
  END IF;
  SELECT (o.ord - 1)::int, o.p INTO v_pos, v_actual
    FROM jsonb_array_elements(v_payload #> '{config,profesionales}') WITH ORDINALITY AS o(p, ord)
   WHERE o.p->>'id' = p_professional_id LIMIT 1;
  IF v_pos IS NULL THEN RAISE EXCEPTION 'El profesional % no existe en la configuración', p_professional_id USING ERRCODE='P0002'; END IF;

  -- Sólo se tocan las claves recibidas (todas ya validadas como permitidas); el resto del profesional queda byte a byte igual.
  v_nuevo := v_actual || p_identity;
  IF v_nuevo IS DISTINCT FROM v_actual THEN
    v_payload := jsonb_set(v_payload, ARRAY['config','profesionales',v_pos::text], v_nuevo, false);
    UPDATE public.cardiolink_atenciones SET payload=v_payload, updated_at=clock_timestamp()
     WHERE id=c_row_id RETURNING updated_at INTO v_upd;
  ELSE
    SELECT a.updated_at INTO v_upd FROM public.cardiolink_atenciones a WHERE a.id=c_row_id;
  END IF;

  SELECT coalesce(jsonb_object_agg(k, v_nuevo->k), '{}'::jsonb) INTO v_ident FROM unnest(c_campos) AS k WHERE v_nuevo ? k;
  RETURN jsonb_build_object('ok', true, 'professionalId', p_professional_id, 'identity', v_ident, 'updatedAt', v_upd);
END
$function$;

REVOKE ALL ON FUNCTION public.cardiolink_guardar_identidad_profesional_v1(text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_guardar_identidad_profesional_v1(text,jsonb) TO authenticated;

-- 2) cardiolink_config_medico_v1(): igual que la versión v3.2 vigente + la identidad documental del PROPIO profesional del médico.
CREATE OR REPLACE FUNCTION public.cardiolink_config_medico_v1()
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT CASE WHEN public.cardiolink_ctx_prof_v1() IS NOT NULL
 THEN jsonb_build_object(
   'profesionales', coalesce((SELECT jsonb_agg(
          jsonb_build_object('id',p->'id','nombre',p->'nombre','area',p->'area','prestaciones',p->'prestaciones')
          -- identidad documental: SÓLO del profesional propio del médico; nunca la de otros profesionales
          || CASE WHEN p->>'id' = public.cardiolink_ctx_prof_v1()
                  THEN coalesce((SELECT jsonb_object_agg(k, p->k)
                                   FROM unnest(ARRAY['marcaDocumento','logoDocumento','logoDocumentoData','firmaDocumentoData',
                                                     'matriculaNacional','matriculaProvincial','telefonoDocumento','emailDocumento',
                                                     'direccionDocumento','redesDocumento','colorDocumento','mostrarFirmaDocumento']) AS k
                                  WHERE p ? k), '{}'::jsonb)
                  ELSE '{}'::jsonb END)
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

-- 3) Verificación posterior (aborta y revierte todo si algo no quedó como se espera).
DO $$
DECLARE v_sec boolean; v_def text;
BEGIN
  SELECT prosecdef INTO v_sec FROM pg_proc WHERE oid='public.cardiolink_guardar_identidad_profesional_v1(text,jsonb)'::regprocedure;
  IF v_sec IS DISTINCT FROM true THEN RAISE EXCEPTION 'La RPC de identidad no quedó SECURITY DEFINER'; END IF;
  IF has_function_privilege('anon','public.cardiolink_guardar_identidad_profesional_v1(text,jsonb)','EXECUTE')
     OR has_function_privilege('public','public.cardiolink_guardar_identidad_profesional_v1(text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'anon/PUBLIC pueden ejecutar la RPC de identidad';
  END IF;
  IF NOT has_function_privilege('authenticated','public.cardiolink_guardar_identidad_profesional_v1(text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated no puede ejecutar la RPC de identidad';
  END IF;
  IF has_function_privilege('anon','public.cardiolink_config_medico_v1()','EXECUTE') THEN
    RAISE EXCEPTION 'anon puede ejecutar cardiolink_config_medico_v1()';
  END IF;
  SELECT prosrc INTO v_def FROM pg_proc WHERE oid='public.cardiolink_config_medico_v1()'::regprocedure;
  IF position('logoDocumentoData' IN v_def)=0 THEN RAISE EXCEPTION 'cardiolink_config_medico_v1() no incluye la identidad propia'; END IF;
END $$;

COMMIT;
