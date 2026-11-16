-- CardioLink · Pendientes de cobro V1 — guard de cobros en backend, v4.2.1 (PARA APROBACIÓN).
-- NO EJECUTADO en Production. Aplicado y probado sólo en STAGING (yslhwdlzdknhskawqrtv). Orden: STAGING (checks -> apply -> tests) y, sólo tras
-- aprobar STAGING, Production (checks -> apply). Rollback: ..._v421_rollback_a_staging_v411.sql / ..._v421_rollback_b_production_sin_guard.sql.
-- Reemplaza a pending_review_cobros_v1_guard_medico.sql (v4.1.1, sin cambios, fuente del rollback A). v4.2.1 corrige los 2 hallazgos de la v4.2
-- probada en STAGING el 2026-11-14 (la v4.2 no se publica): (A) auditoría atribuible a otra persona y (B) carrera INSERT/upsert.
--
-- LO QUE HEREDA (sin cambios) DE v4.2:
--  (1) ASOCIACIONES: owner/admin (cardiolink_has_finance_access) globales; Secretaría ASOCIADA (cardiolink_secretaria_autorizada_prof_v1, asociación
--      ACTIVA) al DESTINATARIO ECONÓMICO = cajaPerfil o, si falta, profesionalId (mismo criterio que app.js) puede confirmar/corregir/borrar; Secretaría
--      no asociada, médico y rol desconocido quedan restringidos como en v4.1.1. Se autoriza contra el valor almacenado (OLD) y el nuevo (NEW). No crea
--      tablas ni políticas y NO toca el RLS de cardiolink_atenciones.
--  (2) INSERT: formas legítimas del alta (sin campos de cobro, 'sin_cobro', 'pendiente', 'cobrado' al registrar); se rechazan marcas de confirmación.
--
-- CORRECCIÓN A (v4.2.1) — IDENTIDAD DE LA CONFIRMACIÓN. La fuente confiable es el JWT autenticado (auth.uid() y auth.jwt() ->> 'email'), nunca
-- metadata del cliente. En la transición pendiente -> cobrado (hecha por owner/admin O por Secretaría asociada; ya no hay excepción para owner/admin):
--   cobroConfirmadoPorId = auth.uid(); cobroConfirmadoPorRol = 'secretaria' (Secretaría) u 'owner'/'admin' (global; el backend sólo distingue la
--   categoría); cobroConfirmadoPorEmail = email autenticado; cobroConfirmadoPor (nombre visible) = email autenticado (ya no se acepta un nombre libre);
--   cobroConfirmadoEn a +-1 día de now(); cobroPendienteEn/Por intactos (no se reescribe el pendiente original); cobroAuditoria = auditoría previa
--   (intacta, prefijo idéntico) + EXACTAMENTE 1 evento nuevo {accion:'confirmado', usuario y email = email autenticado}.
--   Una vez confirmada, la identidad (PorId/Rol/Email/Por, cobroConfirmadoEn, cobroPendiente*) NO se reescribe por la API ni siquiera por owner/admin,
--   y la auditoría sólo admite agregados (de owner/admin, con su propio email); la Secretaría asociada no reescribe nada del estado confirmado.
--   Owner/admin conservan la corrección de importes y medio de pago. Un backup se restaura por INSERT (owner/admin) o SQL Editor: ver NO CUBRE.
--
-- CORRECCIÓN B (v4.2.1) — CARRERA INSERT/UPSERT. BEFORE INSERT corre antes de resolver ON CONFLICT. Con un EXISTS sin bloqueo, un DELETE concurrente
-- (en curso) hacía esperar al upsert y, al liberarse, la fila se insertaba como NUEVA con las marcas ya "validadas" (reproducido con dos sesiones el
-- 2026-11-14). Ahora la comprobación toma FOR KEY SHARE sobre la fila existente: un DELETE concurrente espera (o es esperado) y, si la fila ya no
-- existe, el alta se valida como nueva y se rechaza. Requiere sólo los privilegios y el RLS vigentes (UPDATE de authenticated sobre sus filas).
--
-- INTERCEPTA sólo current_user = authenticated/anon (SECURITY INVOKER). NO intercepta SECURITY DEFINER (cardiolink_pendiente_mutar_v1),
-- service_role (Edge Functions) ni el SQL Editor.
-- NO CUBRE (límites aceptados, ver docs/PENDIENTES_COBRO_V1.md): un alta 'cobrada al registrar' forjada con la forma legítima es indistinguible del
-- alta real (su etiqueta cobroConfirmadoPor/auditoría de ALTA no es una identidad verificada: sólo la confirmación posterior lo es); datos económicos de
-- filas pendientes/cobradas al registrar siguen editables por el médico (flujo actual); owner/admin pueden insertar/restaurar filas con confirmación
-- (restauración de backup) sin validar su contenido; owner vs admin no se distingue sin cardiolink_ctx_rol_v1 (se aceptan ambos); service_role y SQL Editor.
--
-- ESTADO PREVIO. Este script detecta el estado y lo registra en el COMMENT de la función ("estado_previo=sin_guard" si no existe el
-- guard; "estado_previo=v4.1.1 md5_previo=<md5>" si la función vigente es EXACTAMENTE una de las 2 versiones conocidas de v4.1.1:
-- el archivo formateado del repositorio o el cuerpo compacto instalado en STAGING, ambos lógicamente idénticos). Cualquier otro md5 o estado
-- (incluida una v4.2 anterior) aborta SIN cambios. El rollback correcto (A o B) y el cuerpo que restaura dependen de esa marca.

BEGIN;

DO $$
DECLARE
  c_md5_v411_repo constant text := '5d9ac1d364bd571b60f5551d94903e83';     -- pending_review_cobros_v1_guard_medico.sql (formateado, con comentarios)
  c_md5_v411_stg  constant text := 'b511fed99268c140651ee622b84fde0b';     -- cuerpo compacto instalado en STAGING (..._v411_staging_compacto_referencia.sql)
  v_md5 text;
  v_src text; v_cmt text; v_ntrg int; v_f text;
BEGIN
  IF to_regclass('public.cardiolink_atenciones') IS NULL THEN RAISE EXCEPTION 'Falta cardiolink_atenciones'; END IF;
  FOREACH v_f IN ARRAY ARRAY[
      'public.cardiolink_has_appointment_requests_access()', 'public.cardiolink_has_finance_access()',
      'public.cardiolink_secretaria_autorizada_prof_v1(text)', 'public.cardiolink_profesionales_autorizados_secretaria_v1()'] LOOP
    IF to_regprocedure(v_f) IS NULL THEN
      RAISE EXCEPTION 'Precondición: falta % (Seguridad clínica V1 / Finanzas V5 deben estar instaladas en este proyecto)', v_f; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(v_f)) THEN RAISE EXCEPTION 'Precondición: % debe ser SECURITY DEFINER', v_f; END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(v_f), 'EXECUTE') THEN
      RAISE EXCEPTION 'Precondición: authenticated no puede ejecutar %: el guard (SECURITY INVOKER) la invoca con el rol de la API', v_f; END IF;
  END LOOP;
  IF to_regprocedure('public.cardiolink_atenciones_guard_cobro_ins_v1()') IS NOT NULL THEN RAISE EXCEPTION 'La función de INSERT del guard ya existe: no se repite'; END IF;

  SELECT count(*) INTO v_ntrg FROM pg_trigger
   WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND NOT tgisinternal AND tgname LIKE 'cardiolink\_atenciones\_guard\_cobro%';
  IF to_regprocedure('public.cardiolink_atenciones_guard_cobro_v1()') IS NULL THEN
    IF v_ntrg <> 0 THEN RAISE EXCEPTION 'Estado inconsistente: hay triggers de cobros sin función. No se aplica.'; END IF;
    PERFORM set_config('cardiolink.cobros_guard_previo', 'sin_guard', true);
    RAISE NOTICE 'Estado previo detectado: sin_guard (instalación nueva)';
  ELSE
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.cardiolink_atenciones_guard_cobro_v1()'::regprocedure;
    v_cmt := coalesce(obj_description('public.cardiolink_atenciones_guard_cobro_v1()'::regprocedure, 'pg_proc'), '');
    IF v_cmt LIKE '%[cobros-guard v4.2.1]%' THEN RAISE EXCEPTION 'El guard v4.2.1 ya está aplicado: no se repite'; END IF;
    v_md5 := md5(v_src);
    IF v_md5 NOT IN (c_md5_v411_repo, c_md5_v411_stg) THEN
      RAISE EXCEPTION 'La función vigente NO es ninguna de las 2 versiones conocidas de v4.1.1 (md5 %). No se pisa: revisar con _v421_checks.sql', v_md5; END IF;
    IF v_ntrg <> 2 THEN RAISE EXCEPTION 'Se esperaban los 2 triggers de la v4.1.1 y hay %', v_ntrg; END IF;
    PERFORM set_config('cardiolink.cobros_guard_previo', 'v4.1.1 md5_previo=' || v_md5, true);
    RAISE NOTICE 'Estado previo detectado: v4.1.1 (actualización)';
  END IF;
END $$;

-- ===== Guard de UPDATE y DELETE (misma función y mismos triggers que v4.1.1; cambia el cuerpo) =====
CREATE OR REPLACE FUNCTION public.cardiolink_atenciones_guard_cobro_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  c_estado constant text[] := ARRAY[
    'estadoCobro', 'cobroPendienteEn', 'cobroPendientePor', 'cobroConfirmadoEn', 'cobroConfirmadoPor',
    'cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail', 'cobroMedioPago', 'cobroAuditoria'];
  c_economicos constant text[] := ARRAY[
    'montoConsulta', 'montoEstudio', 'montoCopago', 'montoTotal', 'tipoCobro', 'formaPago', 'noCobrar', 'cajaPerfil'];
  c_identidad constant text[] := ARRAY[
    'cobroPendienteEn', 'cobroPendientePor', 'cobroConfirmadoEn', 'cobroConfirmadoPor',
    'cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail'];
  v_campo text;
  v_old_turno text;
  v_new_turno text;
  v_old_prof text;
  v_new_prof text;
  v_ts timestamptz;
  v_global boolean;
  v_aut_sec boolean := false;
  v_mail text;
  v_old_aud jsonb;
  v_new_aud jsonb;
  v_aud_ok boolean := false;
  v_added int := 0;
  v_i int;
BEGIN
  -- Sólo escrituras con rol de la API. SECURITY DEFINER de terceros, service_role y SQL Editor no se interceptan.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  v_global := coalesce(public.cardiolink_has_finance_access(), false);           -- owner / admin
  v_mail := lower(coalesce(auth.jwt() ->> 'email', ''));                          -- identidad autenticada (JWT firmado)
  -- Destinatario económico almacenado (mismo criterio que app.js: cajaPerfil || profesionalId).
  v_old_prof := coalesce(nullif(btrim(OLD.payload ->> 'cajaPerfil'), ''), nullif(btrim(OLD.payload ->> 'profesionalId'), ''));

  IF TG_OP = 'DELETE' THEN
    IF v_global THEN RETURN OLD; END IF;
    IF coalesce(public.cardiolink_has_appointment_requests_access(), false) AND v_old_prof IS NOT NULL
       AND public.cardiolink_secretaria_autorizada_prof_v1(v_old_prof) THEN RETURN OLD; END IF;
    IF OLD.payload ->> 'estadoCobro' = 'pendiente' OR OLD.payload ? 'cobroConfirmadoPorRol' THEN
      RAISE EXCEPTION 'Rol no autorizado para eliminar una atención con cobro pendiente o confirmado.' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  -- ===== UPDATE =====
  -- Secretaría ASOCIADA (asociación activa) al destinatario económico, tanto el almacenado como el nuevo.
  IF NOT v_global AND coalesce(public.cardiolink_has_appointment_requests_access(), false) AND v_old_prof IS NOT NULL
     AND public.cardiolink_secretaria_autorizada_prof_v1(v_old_prof) THEN
    v_new_prof := coalesce(nullif(btrim(NEW.payload ->> 'cajaPerfil'), ''), nullif(btrim(NEW.payload ->> 'profesionalId'), ''));
    v_aut_sec := v_new_prof IS NOT NULL AND public.cardiolink_secretaria_autorizada_prof_v1(v_new_prof);
  END IF;

  IF v_global OR v_aut_sec THEN
    -- Auditoría: prefijo idéntico a la anterior + cantidad de eventos agregados.
    v_old_aud := coalesce(OLD.payload -> 'cobroAuditoria', '[]'::jsonb);
    v_new_aud := coalesce(NEW.payload -> 'cobroAuditoria', '[]'::jsonb);
    IF jsonb_typeof(v_old_aud) = 'array' AND jsonb_typeof(v_new_aud) = 'array' THEN
      IF jsonb_array_length(v_new_aud) >= jsonb_array_length(v_old_aud) THEN
        v_aud_ok := true;
        FOR v_i IN 0 .. jsonb_array_length(v_old_aud) - 1 LOOP
          IF (v_old_aud -> v_i) IS DISTINCT FROM (v_new_aud -> v_i) THEN v_aud_ok := false; EXIT; END IF;
        END LOOP;
        v_added := jsonb_array_length(v_new_aud) - jsonb_array_length(v_old_aud);
      END IF;
    END IF;

    -- Una confirmación existente: su identidad y fecha no se reescriben por la API (ni siquiera por owner/admin).
    IF OLD.payload ? 'cobroConfirmadoPorRol' THEN
      FOREACH v_campo IN ARRAY c_identidad LOOP
        IF (OLD.payload -> v_campo) IS DISTINCT FROM (NEW.payload -> v_campo) THEN
          RAISE EXCEPTION 'Rol no autorizado: la identidad y la fecha de una confirmación no se modifican (%).', v_campo USING ERRCODE = '42501';
        END IF;
      END LOOP;
      IF NOT v_aud_ok THEN
        RAISE EXCEPTION 'Rol no autorizado: la auditoría de un cobro confirmado no se reescribe (sólo se agregan eventos).' USING ERRCODE = '42501'; END IF;
      IF v_aut_sec THEN
        -- La Secretaría asociada no reescribe nada del estado de un cobro ya confirmado (doble confirmación por API directa).
        FOREACH v_campo IN ARRAY c_estado LOOP
          IF (OLD.payload -> v_campo) IS DISTINCT FROM (NEW.payload -> v_campo) THEN
            RAISE EXCEPTION 'Rol no autorizado: el cobro ya fue confirmado y no se vuelve a confirmar ni a modificar (%).', v_campo USING ERRCODE = '42501';
          END IF;
        END LOOP;
      ELSIF v_added > 0 THEN
        -- owner/admin pueden agregar eventos, pero sólo a su nombre.
        FOR v_i IN jsonb_array_length(v_old_aud) .. jsonb_array_length(v_new_aud) - 1 LOOP
          IF v_mail = '' OR lower(coalesce(v_new_aud -> v_i ->> 'email', '')) <> v_mail OR lower(coalesce(v_new_aud -> v_i ->> 'usuario', '')) <> v_mail THEN
            RAISE EXCEPTION 'Rol no autorizado: un evento de auditoría sólo puede atribuirse al usuario autenticado.' USING ERRCODE = '42501'; END IF;
        END LOOP;
      END IF;
    END IF;

    -- Confirmación (pendiente -> cobrado): identidad, rol, email, fecha y auditoría los fija el backend, no el cliente.
    IF OLD.payload ->> 'estadoCobro' = 'pendiente' AND NEW.payload ->> 'estadoCobro' = 'cobrado' THEN
      IF v_mail = '' THEN
        RAISE EXCEPTION 'Rol no autorizado: el token no trae el email del usuario autenticado.' USING ERRCODE = '42501'; END IF;
      IF NEW.payload ->> 'cobroConfirmadoPorId' IS DISTINCT FROM auth.uid()::text THEN
        RAISE EXCEPTION 'Rol no autorizado: cobroConfirmadoPorId debe ser el usuario autenticado.' USING ERRCODE = '42501'; END IF;
      IF (v_global AND coalesce(NEW.payload ->> 'cobroConfirmadoPorRol', '') NOT IN ('owner', 'admin'))
         OR (NOT v_global AND coalesce(NEW.payload ->> 'cobroConfirmadoPorRol', '') <> 'secretaria') THEN
        RAISE EXCEPTION 'Rol no autorizado: cobroConfirmadoPorRol no coincide con el rol autenticado.' USING ERRCODE = '42501'; END IF;
      IF lower(coalesce(NEW.payload ->> 'cobroConfirmadoPorEmail', '')) <> v_mail THEN
        RAISE EXCEPTION 'Rol no autorizado: cobroConfirmadoPorEmail debe ser el email autenticado.' USING ERRCODE = '42501'; END IF;
      IF lower(coalesce(NEW.payload ->> 'cobroConfirmadoPor', '')) <> v_mail THEN
        RAISE EXCEPTION 'Rol no autorizado: cobroConfirmadoPor debe ser la identidad autenticada (no un nombre libre).' USING ERRCODE = '42501'; END IF;
      BEGIN
        v_ts := (NEW.payload ->> 'cobroConfirmadoEn')::timestamptz;
      EXCEPTION WHEN OTHERS THEN v_ts := NULL;
      END;
      IF v_ts IS NULL OR v_ts < now() - interval '1 day' OR v_ts > now() + interval '1 day' THEN
        RAISE EXCEPTION 'Rol no autorizado: cobroConfirmadoEn ausente, inválido o fuera de rango.' USING ERRCODE = '42501'; END IF;
      IF (OLD.payload -> 'cobroPendienteEn') IS DISTINCT FROM (NEW.payload -> 'cobroPendienteEn')
         OR (OLD.payload -> 'cobroPendientePor') IS DISTINCT FROM (NEW.payload -> 'cobroPendientePor') THEN
        RAISE EXCEPTION 'Rol no autorizado: no se reescribe el registro del pendiente original al confirmar.' USING ERRCODE = '42501'; END IF;
      IF NOT v_aud_ok OR v_added <> 1
         OR (v_new_aud -> -1 ->> 'accion') IS DISTINCT FROM 'confirmado'
         OR lower(coalesce(v_new_aud -> -1 ->> 'usuario', '')) <> v_mail
         OR lower(coalesce(v_new_aud -> -1 ->> 'email', '')) <> v_mail THEN
        RAISE EXCEPTION 'Rol no autorizado: la auditoría debe conservar lo anterior y agregar un único evento de confirmación del usuario autenticado.' USING ERRCODE = '42501'; END IF;
    END IF;
    RETURN NEW;
    -- (si la Secretaría no está autorizada para el nuevo destinatario cae a las reglas restrictivas de abajo)
  END IF;

  -- A partir de acá: médico, rol desconocido o Secretaría NO asociada al destinatario económico (reglas v4.1.1, sin cambios).
  -- UPDATE (1): estado de cobro
  FOREACH v_campo IN ARRAY c_estado LOOP
    IF (OLD.payload -> v_campo) IS DISTINCT FROM (NEW.payload -> v_campo) THEN
      RAISE EXCEPTION 'Rol no autorizado para modificar el estado de cobro (%).', v_campo USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- UPDATE (2): cobro ya confirmado por el flujo -> datos económicos congelados
  IF OLD.payload ? 'cobroConfirmadoPorRol' THEN
    FOREACH v_campo IN ARRAY c_economicos LOOP
      IF (OLD.payload -> v_campo) IS DISTINCT FROM (NEW.payload -> v_campo) THEN
        RAISE EXCEPTION 'Rol no autorizado para modificar un dato económico de un cobro confirmado (%).', v_campo USING ERRCODE = '42501';
      END IF;
    END LOOP;
    v_old_turno := lower(coalesce(OLD.payload ->> 'estadoTurno', OLD.payload ->> 'estado', ''));
    v_new_turno := lower(coalesce(NEW.payload ->> 'estadoTurno', NEW.payload ->> 'estado', ''));
    IF v_new_turno IN ('cancelado', 'ausente') AND v_new_turno IS DISTINCT FROM v_old_turno THEN
      RAISE EXCEPTION 'Rol no autorizado para cancelar o marcar ausente una atención con cobro confirmado.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

-- ===== Guard de INSERT (nuevo) =====
CREATE FUNCTION public.cardiolink_atenciones_guard_cobro_ins_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_estado text;
  v_accion_ok text;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  IF coalesce(public.cardiolink_has_finance_access(), false) THEN RETURN NEW; END IF;
  -- Upsert de sincronización: BEFORE INSERT corre antes de resolver ON CONFLICT. Si la fila ya existe no es un alta: lo decide el
  -- trigger de UPDATE (compara OLD contra NEW). Se consulta con el rol de la API: una fila que el llamador no ve se trata como nueva.
  -- FOR KEY SHARE (corrección B): bloquea la fila existente contra un DELETE concurrente hasta el fin de esta transacción; si un DELETE ya está en
  -- curso, espera su resultado y, si la fila desaparece, el alta se valida como nueva (y se rechaza si trae marcas). Sólo exige el UPDATE y el RLS vigentes.
  PERFORM 1 FROM public.cardiolink_atenciones a WHERE a.id = NEW.id FOR KEY SHARE;
  IF FOUND THEN RETURN NEW; END IF;

  v_estado := NEW.payload ->> 'estadoCobro';
  IF v_estado IS NOT NULL AND v_estado NOT IN ('cobrado', 'pendiente', 'sin_cobro') THEN
    RAISE EXCEPTION 'Rol no autorizado para registrar una atención con un estado de cobro desconocido.' USING ERRCODE = '42501'; END IF;
  -- Marcas exclusivas de la confirmación (las pone el flujo de confirmación, nunca el alta).
  IF jsonb_exists_any(NEW.payload, ARRAY['cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail']) THEN
    RAISE EXCEPTION 'Rol no autorizado para registrar una atención con marcas de confirmación de cobro.' USING ERRCODE = '42501'; END IF;
  IF v_estado = 'cobrado' AND jsonb_exists_any(NEW.payload, ARRAY['cobroPendienteEn', 'cobroPendientePor']) THEN
    RAISE EXCEPTION 'Rol no autorizado para registrar un cobro como confirmado de un pendiente.' USING ERRCODE = '42501'; END IF;
  IF v_estado IS DISTINCT FROM 'cobrado' AND jsonb_exists_any(NEW.payload, ARRAY['cobroConfirmadoEn', 'cobroConfirmadoPor', 'cobroMedioPago']) THEN
    RAISE EXCEPTION 'Rol no autorizado para registrar datos de cobro confirmado en una atención no cobrada.' USING ERRCODE = '42501'; END IF;
  IF v_estado IS DISTINCT FROM 'pendiente' AND v_estado IS DISTINCT FROM 'cobrado' AND jsonb_exists_any(NEW.payload, ARRAY['cobroPendienteEn', 'cobroPendientePor']) THEN
    RAISE EXCEPTION 'Rol no autorizado para registrar datos de cobro pendiente en una atención no pendiente.' USING ERRCODE = '42501'; END IF;
  IF jsonb_exists(NEW.payload, 'cobroAuditoria') THEN
    IF jsonb_typeof(NEW.payload -> 'cobroAuditoria') <> 'array' THEN
      RAISE EXCEPTION 'Rol no autorizado para registrar una auditoría de cobro con formato inválido.' USING ERRCODE = '42501'; END IF;
    v_accion_ok := CASE v_estado WHEN 'cobrado' THEN 'cobrado_al_registrar' WHEN 'pendiente' THEN 'pendiente' ELSE NULL END;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload -> 'cobroAuditoria') e
                WHERE jsonb_typeof(e) <> 'object' OR (e ->> 'accion') IS DISTINCT FROM v_accion_ok) THEN
      RAISE EXCEPTION 'Rol no autorizado para registrar una auditoría de cobro con acciones de confirmación.' USING ERRCODE = '42501'; END IF;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.cardiolink_atenciones_guard_cobro_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_atenciones_guard_cobro_ins_v1() FROM PUBLIC, anon, authenticated;

-- ===== Triggers (UPDATE y DELETE con el WHEN exacto de v4.1.1; INSERT nuevo) =====
-- Los WHEN usan EXACTAMENTE los 10 campos protegidos (c_estado de la función). Mantener sincronizadas las listas.
DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1 ON public.cardiolink_atenciones;
DROP TRIGGER IF EXISTS cardiolink_atenciones_guard_cobro_v1_del ON public.cardiolink_atenciones;

CREATE TRIGGER cardiolink_atenciones_guard_cobro_v1
  BEFORE UPDATE ON public.cardiolink_atenciones
  FOR EACH ROW
  WHEN (jsonb_exists_any(OLD.payload, ARRAY['estadoCobro', 'cobroPendienteEn', 'cobroPendientePor', 'cobroConfirmadoEn', 'cobroConfirmadoPor',
                              'cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail', 'cobroMedioPago', 'cobroAuditoria'])
        OR jsonb_exists_any(NEW.payload, ARRAY['estadoCobro', 'cobroPendienteEn', 'cobroPendientePor', 'cobroConfirmadoEn', 'cobroConfirmadoPor',
                              'cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail', 'cobroMedioPago', 'cobroAuditoria']))
  EXECUTE FUNCTION public.cardiolink_atenciones_guard_cobro_v1();

CREATE TRIGGER cardiolink_atenciones_guard_cobro_v1_del
  BEFORE DELETE ON public.cardiolink_atenciones
  FOR EACH ROW
  WHEN (OLD.payload ->> 'estadoCobro' = 'pendiente' OR jsonb_exists(OLD.payload, 'cobroConfirmadoPorRol'))
  EXECUTE FUNCTION public.cardiolink_atenciones_guard_cobro_v1();

CREATE TRIGGER cardiolink_atenciones_guard_cobro_v1_ins
  BEFORE INSERT ON public.cardiolink_atenciones
  FOR EACH ROW
  WHEN (jsonb_exists_any(NEW.payload, ARRAY['estadoCobro', 'cobroPendienteEn', 'cobroPendientePor', 'cobroConfirmadoEn', 'cobroConfirmadoPor',
                              'cobroConfirmadoPorId', 'cobroConfirmadoPorRol', 'cobroConfirmadoPorEmail', 'cobroMedioPago', 'cobroAuditoria']))
  EXECUTE FUNCTION public.cardiolink_atenciones_guard_cobro_ins_v1();

-- Marca de versión y estado previo (los rollbacks A y B la exigen) + verificación posterior (aborta y revierte todo si algo no quedó como se espera).
DO $$
DECLARE v_previo text := current_setting('cardiolink.cobros_guard_previo', true);
BEGIN
  IF v_previo IS NULL OR v_previo NOT IN ('sin_guard', 'v4.1.1 md5_previo=' || '5d9ac1d364bd571b60f5551d94903e83', 'v4.1.1 md5_previo=' || 'b511fed99268c140651ee622b84fde0b') THEN RAISE EXCEPTION 'No se pudo fijar el estado previo (aborta sin cambios)'; END IF;
  EXECUTE format('COMMENT ON FUNCTION public.cardiolink_atenciones_guard_cobro_v1() IS %L',
                 '[cobros-guard v4.2.1] estado_previo=' || v_previo || ' · UPDATE/DELETE: owner/admin global, Secretaría asociada al destinatario económico, resto restringido');
  EXECUTE format('COMMENT ON FUNCTION public.cardiolink_atenciones_guard_cobro_ins_v1() IS %L',
                 '[cobros-guard v4.2.1] estado_previo=' || v_previo || ' · INSERT: sólo formas legítimas del alta');

  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND NOT tgisinternal AND tgenabled = 'O'
        AND tgname IN ('cardiolink_atenciones_guard_cobro_v1', 'cardiolink_atenciones_guard_cobro_v1_del', 'cardiolink_atenciones_guard_cobro_v1_ins')) <> 3 THEN
    RAISE EXCEPTION 'Los 3 triggers de cobros no quedaron habilitados';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid IN ('public.cardiolink_atenciones_guard_cobro_v1()'::regprocedure, 'public.cardiolink_atenciones_guard_cobro_ins_v1()'::regprocedure) AND prosecdef) THEN
    RAISE EXCEPTION 'Las funciones del guard no pueden ser SECURITY DEFINER (current_user dejaría de identificar al rol de la API)';
  END IF;
  IF has_function_privilege('anon', 'public.cardiolink_atenciones_guard_cobro_v1()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.cardiolink_atenciones_guard_cobro_v1()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cardiolink_atenciones_guard_cobro_ins_v1()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.cardiolink_atenciones_guard_cobro_ins_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Las funciones del guard no deben ser ejecutables por anon/authenticated';
  END IF;
  -- El trigger de identidad (si existe) y las 4 políticas RLS no se tocan.
  IF to_regprocedure('public.cardiolink_atenciones_proteger_identidad_v1()') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND tgname = 'cardiolink_atenciones_proteger_identidad_v1') THEN
    RAISE EXCEPTION 'Se perdió el trigger de identidad';
  END IF;
END $$;

COMMIT;
