-- CardioLink · Seguridad clínica V1 · p3c · CHECKS DE SOLO LECTURA (un único SELECT sobre el catálogo; seguro en Production antes y después de CADA paso). No lee contenido clínico: sólo identificadores y conteos.
-- Esperado ANTES de p3c en Production: precondicion_p3c_ok=true, hc_politicas_abiertas=2, hc_politicas_v1=0, forma_hc='abierta', padron_fn=true, p4_insert_docs_padron=true.
-- Esperado tras integridad: trigger_integridad=true. Tras privilegios (D5): grants_endurecidos=true (anon sin nada; authenticated sin TRUNCATE/REFERENCES/TRIGGER y con SELECT/INSERT/UPDATE/DELETE).
-- Esperado DESPUÉS (Production y STAGING): forma_hc='p3c_compartida', hc_politicas_abiertas=0, hc_politicas_v1=8, 0 cuentas con acceso clínico sin rol activo (ver cuentas_sin_rol_activo: no pueden leer HC).
SELECT to_jsonb(x)::text AS estado FROM (SELECT
  current_database() AS db,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') AS hc_politicas_abiertas,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') AS hc_politicas_v1,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) AS hc_politicas_total,
  (CASE
     WHEN (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\' AND qual='true' AND with_check='true') = 2 THEN 'abierta'
     WHEN (SELECT qual FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_select_v1') LIKE '%cardiolink_paciente_padron_v1%'
          AND (SELECT with_check FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_insert_v1') LIKE '%cardiolink_ctx_prof_v1%'
          AND (SELECT qual FROM pg_policies WHERE policyname='cardiolink_hc_resumen_delete_v1') LIKE '%cardiolink_ctx_rol_v1%' THEN 'p3c_compartida'
     WHEN (SELECT qual FROM pg_policies WHERE policyname='cardiolink_hc_evoluciones_select_v1') LIKE '%acceso_clinico%' THEN 'p3_por_relacion'
     ELSE 'otra' END) AS forma_hc,
  to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NOT NULL AS padron_fn,
  to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NOT NULL AS acceso_clinico_fn,
  coalesce((SELECT with_check LIKE '%cardiolink_paciente_padron_v1%' FROM pg_policies WHERE policyname='cardiolink_patient_documents_insert_4c1'), false) AS p4_insert_docs_padron,
  ( (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\' AND permissive='PERMISSIVE' AND cmd='ALL' AND qual='true' AND with_check='true' AND roles=ARRAY['authenticated']::name[]) = 2
    AND (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen')) = 2
    AND to_regprocedure('public.cardiolink_paciente_padron_v1(text)') IS NOT NULL
    AND to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NOT NULL AND to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NOT NULL
    AND (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_evoluciones'::regclass) AND (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_hc_resumen'::regclass) ) AS precondicion_p3c_ok,
  (SELECT jsonb_agg(jsonb_build_object('rol', base_role, 'activo', active, 'prof', professional_id) ORDER BY base_role) FROM public.cardiolink_user_roles) AS roles,
  (SELECT count(*) FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.cardiolink_user_roles r WHERE r.user_id=u.id AND r.active)) AS cuentas_sin_rol_activo,
  (SELECT count(*) FROM public.cardiolink_user_roles WHERE active AND base_role='medico' AND (professional_id IS NULL OR professional_id !~ '^[A-Za-z0-9_.-]{1,64}$')) AS medicos_activos_sin_prof_valido,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_hc_evoluciones'::regclass AND tgname='cardiolink_hc_evoluciones_inmutables_v1' AND tgenabled='O') AS trigger_integridad,
  (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('public.cardiolink_hc_evoluciones'::regclass,'public.cardiolink_hc_resumen'::regclass) AND NOT tgisinternal) AS triggers_sobre_hc,
  (NOT has_table_privilege('anon','public.cardiolink_hc_evoluciones','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AND NOT has_table_privilege('anon','public.cardiolink_hc_resumen','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','SELECT') AND has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','INSERT') AND has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','UPDATE') AND has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','DELETE')
    AND has_table_privilege('authenticated','public.cardiolink_hc_resumen','SELECT') AND has_table_privilege('authenticated','public.cardiolink_hc_resumen','INSERT') AND has_table_privilege('authenticated','public.cardiolink_hc_resumen','UPDATE') AND has_table_privilege('authenticated','public.cardiolink_hc_resumen','DELETE')
    AND NOT has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','TRUNCATE') AND NOT has_table_privilege('authenticated','public.cardiolink_hc_resumen','TRUNCATE')
    AND NOT has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','REFERENCES') AND NOT has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','TRIGGER')) AS grants_endurecidos,
  (SELECT count(*) FROM public.cardiolink_hc_evoluciones WHERE creado_en > now() + interval '1 hour') AS evol_con_creado_en_futuro,
  (SELECT count(*) FROM public.cardiolink_hc_evoluciones WHERE abs(extract(epoch FROM (creado_en - fecha_hora))) > 86400) AS evol_creado_en_vs_fecha_hora_mas_de_24h,
  has_table_privilege('anon','public.cardiolink_hc_evoluciones','SELECT') AS anon_select_evol,
  has_table_privilege('anon','public.cardiolink_hc_evoluciones','TRUNCATE') AS anon_truncate_evol,
  has_table_privilege('authenticated','public.cardiolink_hc_evoluciones','TRUNCATE') AS auth_truncate_evol,
  (SELECT count(*) FROM pg_proc p WHERE p.prosecdef AND p.prosrc ~* 'cardiolink_hc_(evoluciones|resumen)' AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('public', p.oid, 'EXECUTE'))) AS funciones_secdef_que_leen_hc_ejecutables_por_anon,
  (SELECT count(*) FROM public.cardiolink_hc_evoluciones) AS evoluciones,
  (SELECT count(*) FROM public.cardiolink_hc_resumen) AS resumenes,
  (SELECT count(DISTINCT lower(btrim(profesional_id))) FROM public.cardiolink_hc_evoluciones WHERE lower(btrim(profesional_id)) NOT IN (SELECT lower(professional_id) FROM public.cardiolink_user_roles WHERE active AND professional_id IS NOT NULL)) AS autores_de_evoluciones_sin_usuario_activo
) x;
