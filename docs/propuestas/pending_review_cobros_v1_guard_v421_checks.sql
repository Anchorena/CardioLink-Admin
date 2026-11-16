-- CardioLink · Pendientes de cobro V1 — verificaciones de SOLO LECTURA para el guard v4.2.1 (no modifican nada).
-- Ejecutar en el SQL Editor de STAGING y de Production ANTES de aplicar pending_review_cobros_v1_guard_v421.sql, y repetir las consultas 1 a 3
-- DESPUÉS. Pegar los resultados en el informe. No consulta datos clínicos ni nombres: sólo catálogo y conteos agregados.

-- 1) ESTADO DEL GUARD. estado_inferido esperado ANTES: STAGING = 'v4.1.1'; Production = 'sin_guard'. DESPUÉS: 'v4.2.1' en ambos.
--    'desconocido' = NO aplicar (el apply aborta): pegar md5_cuerpo y los triggers para revisar.
WITH f AS (
  SELECT p.oid, p.prosecdef, md5(p.prosrc) AS md5_cuerpo, coalesce(obj_description(p.oid, 'pg_proc'), '') AS comentario
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'cardiolink_atenciones_guard_cobro_v1'),
t AS (
  SELECT count(*) AS n_triggers, string_agg(tgname || ':' || tgenabled::text, ', ' ORDER BY tgname) AS triggers
    FROM pg_trigger WHERE tgrelid = 'public.cardiolink_atenciones'::regclass AND NOT tgisinternal AND tgname LIKE 'cardiolink\_atenciones\_guard\_cobro%')
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM f) AND t.n_triggers = 0 THEN 'sin_guard'
            WHEN EXISTS (SELECT 1 FROM f WHERE comentario LIKE '%[cobros-guard v4.2.1]%') THEN 'v4.2.1'
            WHEN EXISTS (SELECT 1 FROM f WHERE md5_cuerpo IN ('5d9ac1d364bd571b60f5551d94903e83', 'b511fed99268c140651ee622b84fde0b')) AND t.n_triggers = 2 THEN 'v4.1.1'
            ELSE 'desconocido' END AS estado_inferido,
       (SELECT md5_cuerpo FROM f) AS md5_cuerpo, (SELECT prosecdef FROM f) AS security_definer, (SELECT comentario FROM f) AS comentario,
       t.n_triggers, t.triggers
FROM t;

-- 2) Triggers de la tabla. ANTES (v4.1.1): guard_cobro_v1 (UPDATE) y guard_cobro_v1_del (DELETE). DESPUÉS: + guard_cobro_v1_ins (INSERT), los 3 con
--    tgenabled = 'O'. Los BEFORE disparan por orden alfabético: ninguno interfiere con cardiolink_atenciones_proteger_identidad_v1.
SELECT t.tgname, t.tgenabled, p.prosecdef AS security_definer, pg_get_triggerdef(t.oid) AS definicion
FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.cardiolink_atenciones'::regclass AND NOT t.tgisinternal ORDER BY t.tgname;

-- 3) Dependencias del guard v4.2.1 (todas deben existir, ser SECURITY DEFINER y ejecutables por authenticated; ninguna por anon).
SELECT n.nombre, n.para,
       (p.oid IS NOT NULL) AS existe, p.prosecdef AS security_definer,
       CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('authenticated', p.oid, 'EXECUTE') END AS ejecutable_por_authenticated,
       CASE WHEN p.oid IS NOT NULL THEN has_function_privilege('anon', p.oid, 'EXECUTE') END AS ejecutable_por_anon,
       CASE WHEN p.oid IS NOT NULL THEN pg_get_functiondef(p.oid) END AS definicion
FROM (VALUES
  ('cardiolink_has_finance_access',                  'owner/admin activos (acceso global)'),
  ('cardiolink_has_appointment_requests_access',     'owner/admin/secretaría activos'),
  ('cardiolink_secretaria_autorizada_prof_v1',       'Secretaría asociada (asociación ACTIVA) al profesional: Seguridad clínica V1'),
  ('cardiolink_profesionales_autorizados_secretaria_v1', 'profesionales de las asociaciones activas de la Secretaría'),
  ('cardiolink_atencion_permitida_v2',               'predicado de las políticas RLS de atenciones, si 4B etapa B/RLS v2 está aplicada'),
  ('cardiolink_permite_atencion_v1',                 'predicado de las políticas RLS de atenciones (versión anterior)'),
  ('cardiolink_pendiente_mutar_v1',                  'RPC SECURITY DEFINER de pendientes médicos: el guard no la intercepta')
) AS n(nombre, para)
LEFT JOIN pg_proc p ON p.pronamespace = 'public'::regnamespace AND p.proname = n.nombre
ORDER BY n.nombre;

-- 4) Políticas RLS vigentes de cardiolink_atenciones (el guard NO las modifica; sirve para confirmar qué predicado usa cada entorno).
SELECT policyname, cmd, permissive, roles, qual, with_check
FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cardiolink_atenciones' ORDER BY cmd, policyname;

-- 5) Asociaciones (sólo conteos). Esperado: secretarias_activas >= 1 y alguna asociación activa; de lo contrario ninguna Secretaría podrá
--    confirmar cobros hasta que Administración cree las asociaciones (Usuarios y accesos). Médicos/owner sin professional_id no pueden ser
--    destinatarios autorizables.
SELECT (SELECT count(*) FROM public.cardiolink_user_roles WHERE active AND base_role = 'secretaria') AS secretarias_activas,
       (SELECT count(*) FROM public.cardiolink_user_roles WHERE active AND base_role IN ('medico', 'owner', 'admin') AND coalesce(professional_id, '') <> '') AS profesionales_con_id,
       (SELECT count(*) FROM public.cardiolink_secretaria_medicos WHERE activo) AS asociaciones_activas,
       (SELECT count(*) FROM public.cardiolink_secretaria_medicos WHERE NOT activo) AS asociaciones_inactivas;

-- 6) Filas con campos de cobro (sólo conteos; Production antes de publicar: esperado 0 filas con campos de cobro).
SELECT count(*) FILTER (WHERE jsonb_exists_any(payload, ARRAY['estadoCobro', 'cobroPendienteEn', 'cobroPendientePor', 'cobroConfirmadoEn',
                                                              'cobroConfirmadoPor', 'cobroConfirmadoPorId', 'cobroConfirmadoPorRol',
                                                              'cobroConfirmadoPorEmail', 'cobroMedioPago', 'cobroAuditoria'])) AS filas_con_campos_de_cobro,
       count(*) FILTER (WHERE payload ->> 'estadoCobro' = 'pendiente') AS pendientes,
       count(*) FILTER (WHERE payload ? 'cobroConfirmadoPorRol') AS confirmadas_por_el_flujo,
       count(*) AS total
FROM public.cardiolink_atenciones;

-- 7) Destinatarios económicos no autorizables. Una atención con cajaPerfil/profesionalId que NO coincide con el professional_id de ningún
--    usuario activo no podrá ser confirmada por ninguna Secretaría (sólo owner/admin). Esperado: 0 (o explicable). Sólo conteos por valor.
SELECT coalesce(nullif(btrim(a.payload ->> 'cajaPerfil'), ''), nullif(btrim(a.payload ->> 'profesionalId'), ''), '(vacío)') AS destinatario_economico,
       count(*) AS atenciones
FROM public.cardiolink_atenciones a
WHERE coalesce(a.payload ->> 'tipoRegistro', '') NOT IN ('mensaje', 'config')
  AND NOT EXISTS (SELECT 1 FROM public.cardiolink_user_roles r WHERE r.active AND r.professional_id = coalesce(nullif(btrim(a.payload ->> 'cajaPerfil'), ''), nullif(btrim(a.payload ->> 'profesionalId'), '')))
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

-- 8) ¿La caja difiere de quien atiende en las atenciones con cobro? (sólo conteo; justifica autorizar por cajaPerfil y no por profesionalId).
SELECT count(*) FILTER (WHERE nullif(btrim(payload ->> 'cajaPerfil'), '') IS NOT NULL AND payload ->> 'cajaPerfil' IS DISTINCT FROM payload ->> 'profesionalId') AS caja_distinta_de_profesional,
       count(*) AS total_atenciones
FROM public.cardiolink_atenciones
WHERE coalesce(payload ->> 'tipoRegistro', '') NOT IN ('mensaje', 'config');
