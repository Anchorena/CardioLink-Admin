-- CardioLink · Seguridad clínica V1 / Bloque 4B · ROLLBACK de la ETAPA A (RPC de configuración administrativa)  (v2)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización. SOLO STAGING. SIN EJECUTAR (sintaxis sin validar contra una base).
-- Sólo quita las 2 RPC y los 13 helpers creados por pending_review_config_secretaria_v1_a_rpc.sql. No toca políticas, tablas ni datos
-- (la etapa A no modificó ninguno), por lo que este rollback tampoco cambia datos ni la fila __cardiolink_config_v1.
-- ORDEN: si la ETAPA B está aplicada, revertir ANTES la etapa B (…_b_rls_rollback.sql); si no, Secretaría quedaría sin ninguna vía a la configuración.
-- Con el cliente nuevo desplegado, quitar las RPC deja a Secretaría SIN guardado de configuración (con aviso visible; no hay fallback): revertir también el cliente.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
              AND policyname='cardiolink_atenciones_config_solo_admin_v1') THEN
    RAISE EXCEPTION 'Abortado: la ETAPA B sigue aplicada (política cardiolink_atenciones_config_solo_admin_v1). Revertirla primero.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.cardiolink_guardar_config_administrativa_v1(jsonb, text, text, uuid);
DROP FUNCTION IF EXISTS public.cardiolink_config_administrativa_v1();
DROP FUNCTION IF EXISTS public.cardiolink_config_unir_auditoria_v1(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.cardiolink_config_fusionar_profesionales_v1(jsonb, jsonb);
DROP FUNCTION IF EXISTS public.cardiolink_config_fusionar_pacientes_v1(jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.cardiolink_config_paciente_con_clinica_v1(jsonb, text);
DROP FUNCTION IF EXISTS public.cardiolink_config_vista_escritura_sec_v1(jsonb);
DROP FUNCTION IF EXISTS public.cardiolink_config_vista_sec_v1(jsonb);
DROP FUNCTION IF EXISTS public.cardiolink_config_filtrar_objetos_v1(jsonb, text[]);
DROP FUNCTION IF EXISTS public.cardiolink_config_tipos_doc_sec_v1();
DROP FUNCTION IF EXISTS public.cardiolink_config_campos_profesional_admin_v1();
DROP FUNCTION IF EXISTS public.cardiolink_config_campos_paciente_v1();
DROP FUNCTION IF EXISTS public.cardiolink_config_claves_identidad_v1();
DROP FUNCTION IF EXISTS public.cardiolink_config_claves_escritura_sec_v1();
DROP FUNCTION IF EXISTS public.cardiolink_config_claves_lectura_sec_v1();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND (p.proname LIKE 'cardiolink\_config\_%\_sec\_v1' ESCAPE '\'
                     OR p.proname IN ('cardiolink_config_administrativa_v1','cardiolink_guardar_config_administrativa_v1',
                                      'cardiolink_config_claves_identidad_v1','cardiolink_config_campos_paciente_v1',
                                      'cardiolink_config_campos_profesional_admin_v1','cardiolink_config_filtrar_objetos_v1',
                                      'cardiolink_config_paciente_con_clinica_v1','cardiolink_config_fusionar_pacientes_v1',
                                      'cardiolink_config_fusionar_profesionales_v1','cardiolink_config_unir_auditoria_v1'))) THEN
    RAISE EXCEPTION 'Verificación: quedan funciones de la etapa A';
  END IF;
  RAISE NOTICE 'OK rollback etapa A: funciones eliminadas; datos y políticas sin cambios.';
END $$;

COMMIT;
