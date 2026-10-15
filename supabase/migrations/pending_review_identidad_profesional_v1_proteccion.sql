-- CardioLink · Identidad profesional V1 — PROTECCIÓN contra la sobrescritura de la identidad desde la config global (OPCIONAL, SEGUNDA MIGRACIÓN) — v2
-- MIGRACIÓN PENDIENTE DE REVISIÓN. NO EJECUTAR sin autorización explícita. Aplicar DESPUÉS de pending_review_identidad_profesional_v1.sql.
-- Rollback: pending_review_identidad_profesional_v1_proteccion_rollback.sql (sólo quita el trigger y su función; no toca datos ni la identidad archivada).
--
-- RIESGO QUE CUBRE. Owner/admin guardan la fila entera __cardiolink_config_v1 con un upsert ciego (guardarConfigEnSupabase298). Cualquier guardado
-- de configuración desde un equipo con copia vieja (o con la identidad vacía por defecto) reescribe logo/firma/matrículas de TODOS los profesionales,
-- y una copia vieja que no incluya a un profesional lo elimina de la config llevándose su identidad.
--
-- QUÉ HACE (y nada más). Trigger BEFORE UPDATE sólo sobre la fila de config (WHEN OLD.id = '__cardiolink_config_v1'; el resto de las filas ni invoca
-- la función). Se aplica ÚNICAMENTE a escrituras hechas con un rol de la API (current_user = authenticated / anon):
--   1) Para cada profesional que ya existía en OLD y sigue en NEW, restaura a los valores de OLD las 12 claves de identidad
--        marcaDocumento logoDocumento logoDocumentoData firmaDocumentoData matriculaNacional matriculaProvincial telefonoDocumento
--        emailDocumento direccionDocumento redesDocumento colorDocumento mostrarFirmaDocumento
--      (o las quita si OLD no las tenía). TODO lo demás (prestaciones, valores/precios, especialidades, nombre, área, usuarios, obras sociales, pacientes,
--      convenios, profesionales nuevos, orden) pasa tal cual lo envió el cliente.
--   2) Si NEW ya no incluye a un profesional que OLD tenía y éste tenía identidad cargada (algún campo de texto no vacío), esa identidad se ARCHIVA en
--      config.identidadesArchivadas.<id> (lista de {archivadoEn, archivadoPor, identidad}, hasta 5 versiones distintas por profesional, sin duplicar:
--      una identidad igual a cualquiera ya archivada no se vuelve a guardar).
--      El profesional se elimina igual que antes (no se lo resucita: puede ser una baja intencional); sólo se evita perder su identidad en silencio.
--      ARCHIVO LLENO: si el profesional ya tiene 5 versiones archivadas y la identidad que se perdería es distinta de todas, la escritura completa
--      se RECHAZA (ERRCODE 54000) en lugar de descartar esa sexta identidad. Para destrabarlo, mantenimiento (SQL Editor) depura el archivo.
--      El archivo siempre se reconstruye a partir de OLD: un cliente no puede borrarlo ni modificarlo. Se ignoran profesionales sin identidad.
--   3) Si NEW trae una config inválida (config no es un objeto) y OLD tenía identidades o archivo, la escritura se RECHAZA (no se descarta nada en silencio).
--      Si NEW no trae el arreglo profesionales (o no es un arreglo), no se lo toca, pero se archivan las identidades de todos los profesionales de OLD.
--
-- SEGURIDAD DE LA EXCEPCIÓN. Esta versión NO usa ningún marcador de transacción (GUC) para dejar pasar a la RPC: el trigger decide por el rol efectivo
-- (current_user), que un cliente no puede falsificar. La RPC cardiolink_guardar_identidad_profesional_v1 es SECURITY DEFINER y se ejecuta con el rol de su
-- dueño, no como authenticated; por eso el trigger no la intercepta. Mantenimiento (SQL Editor como postgres, service_role) tampoco se intercepta:
-- las restauraciones manuales siguen funcionando. La función del trigger DEBE seguir siendo SECURITY INVOKER (si fuera DEFINER, current_user sería siempre
-- el dueño y la protección dejaría de aplicarse); la verificación final lo comprueba. Un usuario de la API no puede cambiar de rol (SET ROLE a postgres falla).
--
-- NO modifica: datos existentes, políticas RLS, tablas, columnas, grants ni otras funciones. No afecta INSERT, DELETE ni otras filas.
-- No cubre: DELETE de toda la fila de config (lo gobierna la política de DELETE existente) ni cambios hechos por funciones SECURITY DEFINER de terceros.
-- Efecto colateral aceptado: un cliente viejo (sin este hotfix) que edite la identidad por la config global verá que no se guarda; hay que actualizar la app.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_guardar_identidad_profesional_v1(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Falta cardiolink_guardar_identidad_profesional_v1: aplicar antes pending_review_identidad_profesional_v1.sql';
  END IF;
  IF to_regclass('public.cardiolink_atenciones') IS NULL THEN RAISE EXCEPTION 'Falta cardiolink_atenciones'; END IF;
  IF to_regprocedure('public.cardiolink_atenciones_proteger_identidad_v1()') IS NOT NULL THEN
    RAISE EXCEPTION 'La protección ya existe: no se repite';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_atenciones'::regclass AND tgname='cardiolink_atenciones_proteger_identidad_v1') THEN
    RAISE EXCEPTION 'El trigger de protección ya existe: no se repite';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.cardiolink_guardar_identidad_profesional_v1(text,jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'La RPC de identidad debe ser SECURITY DEFINER: el trigger la distingue por el rol de su dueño';
  END IF;
END $$;

CREATE FUNCTION public.cardiolink_atenciones_proteger_identidad_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  c_campos constant text[] := ARRAY['marcaDocumento','logoDocumento','logoDocumentoData','firmaDocumentoData','matriculaNacional',
                                    'matriculaProvincial','telefonoDocumento','emailDocumento','direccionDocumento','redesDocumento',
                                    'colorDocumento','mostrarFirmaDocumento'];
  v_old    jsonb := OLD.payload #> '{config,profesionales}';
  v_new    jsonb := NEW.payload #> '{config,profesionales}';
  v_arch0  jsonb := CASE WHEN jsonb_typeof(OLD.payload #> '{config,identidadesArchivadas}') = 'object'
                         THEN OLD.payload #> '{config,identidadesArchivadas}' ELSE '{}'::jsonb END;
  v_arch   jsonb;
  v_res    jsonb;
  v_p      jsonb;
  v_ident  jsonb;
  v_lista  jsonb;
  v_id     text;
BEGIN
  -- Sólo escrituras con rol de la API. Dueño de la RPC (SECURITY DEFINER), SQL Editor y service_role no se interceptan. current_user no se puede falsificar.
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  v_arch := v_arch0;

  IF jsonb_typeof(NEW.payload -> 'config') IS DISTINCT FROM 'object' THEN
    -- Una config inválida se rechaza sólo si descartaría identidades o su archivo (no se pierde nada en silencio).
    IF v_arch0 <> '{}'::jsonb OR (jsonb_typeof(v_old) = 'array' AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_old) o(p), unnest(c_campos) k
          WHERE jsonb_typeof(o.p) = 'object' AND jsonb_typeof(o.p -> k) = 'string' AND (o.p ->> k) <> '')) THEN
      RAISE EXCEPTION 'Configuración inválida: se rechaza porque eliminaría la identidad documental de los profesionales' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
  END IF;

  IF jsonb_typeof(v_old) = 'array' THEN
    -- (2) profesionales de OLD que NEW ya no tiene: su identidad se archiva
    FOR v_p IN
      SELECT o.p FROM jsonb_array_elements(v_old) o(p)
       WHERE jsonb_typeof(o.p) = 'object' AND o.p ? 'id'
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_new) = 'array' THEN v_new ELSE '[]'::jsonb END) n(p)
                          WHERE jsonb_typeof(n.p) = 'object' AND n.p ->> 'id' = o.p ->> 'id')
    LOOP
      v_id := v_p ->> 'id';
      SELECT coalesce(jsonb_object_agg(k, v_p -> k), '{}'::jsonb) INTO v_ident FROM unnest(c_campos) AS k WHERE v_p ? k;
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM jsonb_each(v_ident) e WHERE jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') <> '');
      v_lista := CASE WHEN jsonb_typeof(v_arch -> v_id) = 'array' THEN v_arch -> v_id ELSE '[]'::jsonb END;
      -- ya archivada (igual a cualquier versión guardada): no se pierde nada y no se duplica
      CONTINUE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_lista) a(x) WHERE a.x -> 'identidad' = v_ident);
      -- archivo lleno: una sexta identidad distinta NO se descarta en silencio; se rechaza toda la escritura
      IF jsonb_array_length(v_lista) >= 5 THEN
        RAISE EXCEPTION 'No se guardó la configuración: el profesional % ya no figura y su identidad documental se perdería (ya tiene 5 identidades archivadas)', v_id
          USING ERRCODE = '54000',
                HINT = 'Volver a incluir al profesional en la configuración, o depurar config.identidadesArchivadas desde el SQL Editor (mantenimiento) antes de quitarlo.';
      END IF;
      v_arch := jsonb_set(v_arch, ARRAY[v_id],
                  v_lista || jsonb_build_array(jsonb_build_object('archivadoEn', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                                                                  'archivadoPor', auth.uid(), 'identidad', v_ident)), true);
    END LOOP;

    -- (1) profesionales que siguen: se restauran las 12 claves de identidad de OLD
    IF jsonb_typeof(v_new) = 'array' THEN
      SELECT jsonb_agg(
               CASE WHEN o.p IS NULL OR jsonb_typeof(n.p) <> 'object' THEN n.p
                    ELSE (n.p - c_campos)
                         || coalesce((SELECT jsonb_object_agg(k, o.p -> k) FROM unnest(c_campos) AS k WHERE o.p ? k), '{}'::jsonb)
               END
               ORDER BY n.ord)
        INTO v_res
        FROM jsonb_array_elements(v_new) WITH ORDINALITY AS n(p, ord)
        LEFT JOIN LATERAL (SELECT oo.p FROM jsonb_array_elements(v_old) AS oo(p)
                            WHERE jsonb_typeof(oo.p) = 'object' AND n.p ? 'id' AND oo.p ->> 'id' = n.p ->> 'id' LIMIT 1) AS o ON true;
      IF v_res IS DISTINCT FROM v_new THEN
        NEW.payload := jsonb_set(NEW.payload, '{config,profesionales}', coalesce(v_res, '[]'::jsonb), false);
      END IF;
    END IF;
  END IF;

  -- el archivo siempre sale de OLD (+ lo recién archivado): un cliente no puede borrarlo ni modificarlo
  IF v_arch <> '{}'::jsonb OR NEW.payload #> '{config,identidadesArchivadas}' IS NOT NULL THEN
    IF v_arch = '{}'::jsonb THEN
      NEW.payload := NEW.payload #- '{config,identidadesArchivadas}';
    ELSE
      NEW.payload := jsonb_set(NEW.payload, '{config,identidadesArchivadas}', v_arch, true);
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.cardiolink_atenciones_proteger_identidad_v1() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER cardiolink_atenciones_proteger_identidad_v1
  BEFORE UPDATE ON public.cardiolink_atenciones
  FOR EACH ROW WHEN (OLD.id = '__cardiolink_config_v1')
  EXECUTE FUNCTION public.cardiolink_atenciones_proteger_identidad_v1();

-- Verificación posterior (aborta y revierte todo si algo no quedó como se espera).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_atenciones'::regclass AND NOT tgisinternal
                  AND tgname='cardiolink_atenciones_proteger_identidad_v1' AND tgenabled='O') THEN
    RAISE EXCEPTION 'El trigger de protección no quedó habilitado';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.cardiolink_atenciones_proteger_identidad_v1()'::regprocedure) THEN
    RAISE EXCEPTION 'La función del trigger no puede ser SECURITY DEFINER (current_user dejaría de identificar al rol de la API)';
  END IF;
  IF has_function_privilege('anon','public.cardiolink_atenciones_proteger_identidad_v1()','EXECUTE')
     OR has_function_privilege('authenticated','public.cardiolink_atenciones_proteger_identidad_v1()','EXECUTE') THEN
    RAISE EXCEPTION 'La función del trigger no debe ser ejecutable por anon/authenticated';
  END IF;
END $$;

COMMIT;
