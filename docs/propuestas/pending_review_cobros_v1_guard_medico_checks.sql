-- CardioLink · Pendientes de cobro V1 — verificaciones de SOLO LECTURA (no modifican nada).
-- Ejecutar en el SQL Editor de STAGING y de Production ANTES de aplicar pending_review_cobros_v1_guard_medico.sql, y volver a
-- ejecutar las consultas 1, 2, 3 y 6 DESPUÉS. Pegar los resultados en el informe. Resultado esperado indicado en cada consulta.

-- 1) Políticas RLS de cardiolink_atenciones (esperado: 4 — select/insert/update/delete — todas con cardiolink_permite_atencion_v1).
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cardiolink_atenciones' ORDER BY cmd, policyname;

-- 2) Triggers de la tabla.
--    ANTES: sólo cardiolink_atenciones_proteger_identidad_v1.
--    DESPUÉS: + cardiolink_atenciones_guard_cobro_v1 (BEFORE UPDATE) y cardiolink_atenciones_guard_cobro_v1_del (BEFORE DELETE),
--    ambos tgenabled = 'O' y con security_definer = false. Los BEFORE disparan por orden alfabético de nombre: guard_cobro_v1 va
--    antes que proteger_identidad_v1 y no interfieren (identidad sólo actúa sobre la fila de config; el guard sobre filas con cobro).
SELECT t.tgname, t.tgenabled, p.prosecdef AS security_definer, pg_get_triggerdef(t.oid) AS definicion
FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.cardiolink_atenciones'::regclass AND NOT t.tgisinternal ORDER BY t.tgname;

-- 3) Funciones de autorización y soporte que usan la app, las políticas y el guard. 'existe' = false marca una función ausente.
--    ESPERADO en STAGING (verificado): cardiolink_has_appointment_requests_access existe, SECURITY DEFINER, ejecutable por
--    authenticated, usa auth.uid() y devuelve true para owner/admin/secretaria activos y false para médico; y
--    cardiolink_pendiente_mutar_v1 existe y es SECURITY DEFINER. El guard (SECURITY INVOKER) llama a la primera con el rol de la API:
--    si authenticated no puede ejecutarla, NO aplicar. Las demás dependen del entorno: anotar cuáles existen en cada proyecto.
SELECT n.nombre,
       n.rol_en_el_guard,
       (p.oid IS NOT NULL) AS existe,
       p.prosecdef AS security_definer,
       CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('authenticated', p.oid, 'EXECUTE') END AS ejecutable_por_authenticated,
       CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('anon', p.oid, 'EXECUTE') END AS ejecutable_por_anon,
       CASE WHEN p.oid IS NOT NULL THEN pg_get_functiondef(p.oid) END AS definicion
FROM (VALUES
  ('cardiolink_has_appointment_requests_access', 'DEPENDENCIA del guard: true = owner/admin/secretaría'),
  ('cardiolink_es_admin_u_owner',                'usada por la app (admin/owner); el guard NO la usa'),
  ('cardiolink_permite_atencion_v1',             'usada por las 4 políticas RLS de cardiolink_atenciones'),
  ('cardiolink_identidad_pendientes_v1',         'usada por la app (identidad médica); el guard NO la usa'),
  ('cardiolink_pendiente_mutar_v1',              'RPC SECURITY DEFINER de pendientes médicos: el guard no la intercepta (prueba 9)'),
  ('cardiolink_guardar_identidad_profesional_v1','RPC de identidad; el guard no interviene'),
  ('cardiolink_atenciones_proteger_identidad_v1','trigger de identidad existente (sólo fila de config)'),
  ('cardiolink_atenciones_guard_cobro_v1',       'el guard de cobros (ANTES: existe = false)')
) AS n(nombre, rol_en_el_guard)
LEFT JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace AND p.proname = n.nombre
ORDER BY n.nombre;

-- 4) Roles reales (el guard asume owner/admin/secretaria/medico; un rol personalizado debe mapear a uno de ellos).
SELECT base_role, active, count(*) FROM public.cardiolink_user_roles GROUP BY 1, 2 ORDER BY 1, 2;

-- 5) ¿Qué filas existen con campos de cobro? (Production: esperado 0 hasta publicar la funcionalidad. STAGING: las de QA.)
--    Alcance del guard: sólo estas filas ejecutan el trigger de UPDATE; el resto de las atenciones (históricas) no.
SELECT count(*) FILTER (WHERE jsonb_exists_any(payload, ARRAY['estadoCobro', 'cobroPendienteEn', 'cobroPendientePor', 'cobroConfirmadoEn',
                                                              'cobroConfirmadoPor', 'cobroConfirmadoPorId', 'cobroConfirmadoPorRol',
                                                              'cobroConfirmadoPorEmail', 'cobroMedioPago', 'cobroAuditoria'])) AS filas_con_campos_de_cobro,
       count(*) FILTER (WHERE payload ->> 'estadoCobro' = 'pendiente') AS pendientes,
       count(*) FILTER (WHERE payload ? 'cobroConfirmadoPorRol') AS confirmadas_por_el_flujo,
       count(*) AS total
FROM public.cardiolink_atenciones;

-- 6) ¿Existe ya el guard (función y triggers)? (esperado ANTES: 0 filas en ambas.)
SELECT 'funcion' AS tipo, proname AS nombre FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'cardiolink_atenciones_guard_cobro_v1'
UNION ALL
SELECT 'trigger', tgname FROM pg_trigger
 WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND tgname IN ('cardiolink_atenciones_guard_cobro_v1', 'cardiolink_atenciones_guard_cobro_v1_del');
