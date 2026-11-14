-- CardioLink · Seguridad clínica V1 · BLOQUE 4C-1b (ajuste v2.2; parte de la entrega 4C-1; se aplica por separado porque la etapa A de 4B ya está instalada en STAGING) · Certificados, órdenes y reposos HEREDADOS legibles por Secretaría, sin reabrir la fila de configuración completa
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. Primero STAGING (yslhwdlzdknhskawqrtv). SIN EJECUTAR: sintaxis sin validar.
-- Decisión del dueño: ampliar el acceso administrativo a certificados y órdenes heredados SIN reabrir la fila completa. La fila `__cardiolink_config_v1` sigue cerrada a Secretaría (etapa B de 4B);
-- ella sólo recibe, por la RPC administrativa `cardiolink_config_administrativa_v1()`, la lista saneada de `documentosClinicos` filtrada por TIPO. Este SQL sólo amplía ESA lista de tipos.
-- QUÉ HACE (y nada más):
--   1) CREATE OR REPLACE de cardiolink_config_tipos_doc_sec_v1(): de {constancia_atencion} a {constancia_atencion, certificado, reposo_laboral, orden}.
--   2) DECISIÓN v2.2 (Secretaría sólo ve documentos de profesionales con asociación ACTIVA): CREATE OR REPLACE de cardiolink_config_vista_sec_v1(jsonb) —la vista de LECTURA de la RPC administrativa—: además del tipo, cada
--      documento heredado debe tener `profesionalId` entre los profesionales autorizados de la Secretaría que consulta (cardiolink_profesionales_autorizados_secretaria_v1, de 4C-1). Sin profesionalId ⇒ no se entrega. Deja de ser
--      IMMUTABLE (depende de la sesión): pasa a STABLE. Sólo la usa la RPC de LECTURA (el hash de concurrencia usa la vista de escritura, que no cambia). Requiere 4C-1 aplicado ANTES.
-- LECTURA solamente: la escritura de documentosClinicos por Secretaría sigue siendo NUNCA (la RPC de guardado no la admite). Receta, ECG, estudios, mensajes a colega y demás tipos heredados siguen fuera.
-- CLIENTE Y 4B: ya incorporados en el árbol (app.js TIPOS_DOC_SECRETARIA_V1, cardiolink-config-secretaria-v1.js TIPOS_DOC_LECTURA, etapa A de 4B y sus pruebas B2/C14/D8 y SQL QA). Este archivo lleva la BASE YA INSTALADA
-- a la misma lista (la etapa A original sólo devolvía constancia_atencion). Aplicarlo ANTES que el cliente nuevo es inocuo (el cliente viejo filtra por su cuenta); después, el cliente nuevo ve los tipos ampliados.
-- Rollback: pending_review_documentos_seguridad_4c1b_heredados_rollback.sql.
BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.cardiolink_config_tipos_doc_sec_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: falta la etapa A de 4B (cardiolink_config_tipos_doc_sec_v1)'; END IF;
  IF (SELECT public.cardiolink_config_tipos_doc_sec_v1()) IS DISTINCT FROM ARRAY['constancia_atencion']::text[] THEN
    RAISE EXCEPTION 'Precondición: la lista vigente no es la esperada (constancia_atencion): ¿ya aplicado?'; END IF;
  IF to_regprocedure('public.cardiolink_config_vista_sec_v1(jsonb)') IS NULL THEN RAISE EXCEPTION 'Precondición: falta cardiolink_config_vista_sec_v1(jsonb) (etapa A de 4B)'; END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.cardiolink_config_vista_sec_v1(jsonb)'::regprocedure) <> 'i' THEN RAISE EXCEPTION 'Precondición: la vista de lectura ya no es la original (¿ya aplicado?)'; END IF;
  IF to_regprocedure('public.cardiolink_profesionales_autorizados_secretaria_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: aplicar antes el bloque 4C-1 (profesionales autorizados de Secretaría)'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.cardiolink_config_tipos_doc_sec_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- TIPOS_DOC_INICIO
  'constancia_atencion','certificado','reposo_laboral','orden'
  -- TIPOS_DOC_FIN
 ]::text[]
$f$;

-- Vista de LECTURA con la restricción por profesional autorizado (v2.2). Conserva grants (CREATE OR REPLACE): sin EXECUTE para anon/authenticated.
CREATE OR REPLACE FUNCTION public.cardiolink_config_vista_sec_v1(p_config jsonb)
 RETURNS jsonb LANGUAGE sql STABLE
AS $f$
 SELECT coalesce(jsonb_object_agg(k,
          CASE
            WHEN k = 'pacientes' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k, public.cardiolink_config_campos_paciente_v1())
            WHEN k = 'profesionales' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k,
                     public.cardiolink_config_campos_profesional_admin_v1() || public.cardiolink_config_claves_identidad_v1())
            WHEN k = 'documentosClinicos' AND jsonb_typeof(p_config -> k) = 'array'
              THEN coalesce((SELECT jsonb_agg(d.x ORDER BY d.ord)
                               FROM jsonb_array_elements(p_config -> k) WITH ORDINALITY AS d(x, ord)
                              WHERE jsonb_typeof(d.x) = 'object' AND (d.x ->> 'tipo') = ANY (public.cardiolink_config_tipos_doc_sec_v1())
                                AND (d.x ->> 'profesionalId') = ANY (coalesce(public.cardiolink_profesionales_autorizados_secretaria_v1(), ARRAY[]::text[]))), '[]'::jsonb)
            ELSE p_config -> k
          END) FILTER (WHERE p_config ? k), '{}'::jsonb)
   FROM unnest(public.cardiolink_config_claves_lectura_sec_v1()) AS k
$f$;

DO $$
BEGIN
  IF (SELECT public.cardiolink_config_tipos_doc_sec_v1()) IS DISTINCT FROM ARRAY['constancia_atencion','certificado','reposo_laboral','orden']::text[] THEN RAISE EXCEPTION 'FALLA: lista inesperada'; END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.cardiolink_config_vista_sec_v1(jsonb)'::regprocedure) <> 's' THEN RAISE EXCEPTION 'FALLA: la vista de lectura debe ser STABLE'; END IF;
  IF has_function_privilege('anon','public.cardiolink_config_vista_sec_v1(jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.cardiolink_config_vista_sec_v1(jsonb)','EXECUTE') THEN RAISE EXCEPTION 'FALLA: la vista de lectura es interna'; END IF;
  IF has_function_privilege('anon','public.cardiolink_config_tipos_doc_sec_v1()','EXECUTE') OR has_function_privilege('authenticated','public.cardiolink_config_tipos_doc_sec_v1()','EXECUTE') THEN
    RAISE EXCEPTION 'FALLA: la función es interna (sin EXECUTE para anon/authenticated) y debe seguir así'; END IF;
END $$;

COMMIT;
