-- CardioLink · Seguridad clínica V1 · p3c · HUELLA DE ESTADO (SOLO LECTURA: un único SELECT; seguro en Production). Sin contenido clínico: sólo hashes y conteos.
-- Uso: ejecutarla ANTES y DESPUÉS del ensayo reversible (y de un rollback): `huella_total` debe ser IDÉNTICA. Es la prueba de que el ensayo no dejó ningún cambio persistente
-- en políticas, privilegios, triggers, funciones ni cuentas/roles (el ensayo crea cuentas sintéticas: cualquier resto cambiaría `cuentas_y_roles`).
-- `conteos_vivos` (pacientes, evoluciones, resúmenes, documentos, atenciones) es INFORMATIVO y queda fuera de `huella_total`: en Production el consultorio trabaja y esos números cambian solos.
SELECT to_jsonb(x)::text AS huella FROM (
  SELECT h.*, md5(concat_ws('|', h.politicas_hc_y_docs, h.privilegios_hc, h.triggers_hc, h.funciones, h.cuentas_y_roles)) AS huella_total
  FROM (SELECT
    (SELECT md5(coalesce(string_agg(concat_ws('~', tablename, policyname, cmd, permissive, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname), ''))
       FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen','cardiolink_patient_documents')) AS politicas_hc_y_docs,
    (SELECT md5(coalesce(string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), E'\n' ORDER BY c.relname), ''))
       FROM pg_class c WHERE c.oid IN ('public.cardiolink_hc_evoluciones'::regclass, 'public.cardiolink_hc_resumen'::regclass)) AS privilegios_hc,
    (SELECT md5(coalesce(string_agg(tgrelid::regclass::text || ':' || tgname || ':' || tgenabled::text, E'\n' ORDER BY tgrelid::regclass::text, tgname), ''))
       FROM pg_trigger WHERE tgrelid IN ('public.cardiolink_hc_evoluciones'::regclass, 'public.cardiolink_hc_resumen'::regclass) AND NOT tgisinternal) AS triggers_hc,
    (SELECT md5(coalesce(string_agg(p.proname || ':' || md5(p.prosrc) || ':' || coalesce(p.proacl::text, ''), E'\n' ORDER BY p.proname), ''))
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'cardiolink\_%' ESCAPE '\') AS funciones,
    (SELECT (SELECT count(*) FROM auth.users) || ',' || (SELECT count(*) FROM public.cardiolink_user_roles)) AS cuentas_y_roles,
    (SELECT concat_ws(',', (SELECT count(*) FROM public.cardiolink_pacientes),
       (SELECT count(*) FROM public.cardiolink_hc_evoluciones), (SELECT count(*) FROM public.cardiolink_hc_resumen), (SELECT count(*) FROM public.cardiolink_patient_documents),
       (SELECT count(*) FROM public.cardiolink_atenciones))) AS conteos_vivos
  ) h
) x;
