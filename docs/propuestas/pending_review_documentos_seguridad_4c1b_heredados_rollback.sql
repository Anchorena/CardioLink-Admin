-- Rollback del Bloque 4C-1b (v2.2): vuelve la lista de tipos heredados legibles por Secretaría a {constancia_atencion} Y la vista de lectura a su definición original (IMMUTABLE, sin filtro por profesional). No toca datos.
BEGIN;
CREATE OR REPLACE FUNCTION public.cardiolink_config_tipos_doc_sec_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- TIPOS_DOC_INICIO
  'constancia_atencion'
  -- TIPOS_DOC_FIN
 ]::text[]
$f$;
CREATE OR REPLACE FUNCTION public.cardiolink_config_vista_sec_v1(p_config jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE
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
                              WHERE jsonb_typeof(d.x) = 'object' AND (d.x ->> 'tipo') = ANY (public.cardiolink_config_tipos_doc_sec_v1())), '[]'::jsonb)
            ELSE p_config -> k
          END) FILTER (WHERE p_config ? k), '{}'::jsonb)
   FROM unnest(public.cardiolink_config_claves_lectura_sec_v1()) AS k
$f$;
DO $$
BEGIN
  IF (SELECT public.cardiolink_config_tipos_doc_sec_v1()) IS DISTINCT FROM ARRAY['constancia_atencion']::text[] THEN RAISE EXCEPTION 'FALLA: no se restauró la lista'; END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.cardiolink_config_vista_sec_v1(jsonb)'::regprocedure) <> 'i' THEN RAISE EXCEPTION 'FALLA: no se restauró la vista de lectura original'; END IF;
  IF pg_get_functiondef('public.cardiolink_config_vista_sec_v1(jsonb)'::regprocedure) ~ 'profesionalId' THEN RAISE EXCEPTION 'FALLA: la vista de lectura conserva el filtro por profesional'; END IF;
END $$;
COMMIT;
