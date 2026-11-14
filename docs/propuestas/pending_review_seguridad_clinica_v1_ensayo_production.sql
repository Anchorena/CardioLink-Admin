-- CardioLink · Seguridad clínica V1 · ENSAYO REVERSIBLE PARA PRODUCTION (ARCHIVO GENERADO: no editar a mano; ver ..._generar_ensayo_integracion.sh)
-- NO EJECUTAR sin autorización explícita. Aplica, DENTRO de una transacción, p1 → p2 → 4B etapa A → 4B etapa B → 4C-1 → 4C-1b (p3 / HC RLS POSTERGADO: no se aplica) y corre los checks; termina SIEMPRE con una excepción informativa (sin COMMIT): nada queda persistido.
-- Toma bloqueos de DDL durante unos segundos: ejecutar fuera del horario de uso. «ENSAYO_PRODUCTION_OK …» = el orden de publicación (sin p3) es aplicable sobre el catálogo real de Production.
-- SIN EJECUTAR: sintaxis sin validar contra una base.

DO $$
BEGIN
  IF to_regclass('public.cardiolink_secretaria_medicos') IS NOT NULL OR to_regclass('public.cardiolink_paciente_profesionales_v1') IS NOT NULL OR to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_config_tipos_doc_sec_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE 'cardiolink_hc_%\_v1' ESCAPE '\') THEN
    RAISE EXCEPTION 'El ensayo requiere un Production SIN ninguna de las partes aplicada (estado esperado de partida). No se hizo nada.'; END IF;
END $$;

BEGIN;
-- ---------- p1 ----------
-- CardioLink · Seguridad clínica V1 · PARTE 1 · Asociaciones Secretaría–Médico (Bloque 3)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md

DO $$
BEGIN
  IF to_regclass('public.cardiolink_user_roles') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_user_roles'; END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_user_roles' AND column_name IN ('user_id','base_role','active','professional_id','cardiolink_user_key')) <> 5 THEN
    RAISE EXCEPTION 'Precondición: faltan columnas de cardiolink_user_roles (user_id, base_role, active, professional_id, cardiolink_user_key)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid='public.cardiolink_user_roles'::regclass AND i.indisunique AND i.indnatts=1
                  AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=i.indrelid AND a.attnum=i.indkey[0]) = 'user_id') THEN
    RAISE EXCEPTION 'Precondición: cardiolink_user_roles.user_id debe ser único (clave de las asociaciones)'; END IF;
  IF to_regclass('public.cardiolink_secretaria_medicos') IS NOT NULL OR to_regclass('public.cardiolink_secretaria_medicos_eventos_v1') IS NOT NULL OR to_regprocedure('public.cardiolink_validar_asociacion_secretaria_medico_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_auditar_secretaria_medico_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_asociar_secretaria_medico_v1(uuid, uuid, boolean)') IS NOT NULL OR to_regprocedure('public.cardiolink_listar_asociaciones_v1()') IS NOT NULL THEN RAISE EXCEPTION 'La PARTE 1 (asociaciones) ya está aplicado (o parcialmente): no se repite'; END IF;
END $$;

CREATE TABLE public.cardiolink_secretaria_medicos (
  secretaria_user_id uuid NOT NULL,
  medico_user_id uuid NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  creado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cardiolink_secretaria_medicos_pkey PRIMARY KEY (secretaria_user_id, medico_user_id),
  CONSTRAINT cardiolink_secretaria_medicos_medico_user_id_fkey FOREIGN KEY (medico_user_id) REFERENCES public.cardiolink_user_roles(user_id) ON DELETE CASCADE,
  CONSTRAINT cardiolink_secretaria_medicos_secretaria_user_id_fkey FOREIGN KEY (secretaria_user_id) REFERENCES public.cardiolink_user_roles(user_id) ON DELETE CASCADE,
  CONSTRAINT asociacion_usuarios_distintos CHECK ((secretaria_user_id <> medico_user_id))
);
CREATE INDEX cardiolink_secretaria_medicos_medico_idx ON public.cardiolink_secretaria_medicos USING btree (medico_user_id, secretaria_user_id) WHERE activo;
ALTER TABLE public.cardiolink_secretaria_medicos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cardiolink_secretaria_medicos FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cardiolink_secretaria_medicos TO service_role;

CREATE TABLE public.cardiolink_secretaria_medicos_eventos_v1 (
  id bigint GENERATED ALWAYS AS IDENTITY,
  secretaria_user_id uuid NOT NULL,
  medico_user_id uuid NOT NULL,
  activo_anterior boolean,
  activo_nuevo boolean NOT NULL,
  actor uuid NOT NULL,
  registrado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cardiolink_secretaria_medicos_eventos_v1_pkey PRIMARY KEY (id)
);
ALTER TABLE public.cardiolink_secretaria_medicos_eventos_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cardiolink_secretaria_medicos_eventos_v1 FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cardiolink_secretaria_medicos_eventos_v1 TO service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_validar_asociacion_secretaria_medico_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
 if not exists (
   select 1 from public.cardiolink_user_roles u
   where u.user_id=new.secretaria_user_id and u.active and u.base_role='secretaria'
 ) then raise exception 'La secretaria debe tener rol activo de secretaria';
 end if;
 if not exists (
   select 1 from public.cardiolink_user_roles u
   where u.user_id=new.medico_user_id and u.active
     and u.base_role in ('medico','owner')
     and nullif(btrim(u.professional_id),'') is not null
 ) then raise exception 'El profesional debe tener rol activo y professional_id';
 end if;
 return new;
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_validar_asociacion_secretaria_medico_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_validar_asociacion_secretaria_medico_v1() TO service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_auditar_secretaria_medico_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
 insert into public.cardiolink_secretaria_medicos_eventos_v1
 (secretaria_user_id,medico_user_id,activo_anterior,activo_nuevo,actor)
 values(new.secretaria_user_id,new.medico_user_id,
 case when tg_op='UPDATE' then old.activo else null end,
 new.activo,auth.uid());
 return new;
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_auditar_secretaria_medico_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_auditar_secretaria_medico_v1() TO service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_asociar_secretaria_medico_v1(p_secretaria_user_id uuid, p_medico_user_id uuid, p_activo boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
 if auth.uid() is null or not exists(
   select 1 from public.cardiolink_user_roles r
    where r.user_id=auth.uid() and r.active and r.base_role in ('owner','admin')
 ) then raise exception 'Sin permiso para gestionar asociaciones' using errcode='42501'; end if;
 if p_activo is null or p_secretaria_user_id is null or p_medico_user_id is null then
   raise exception 'Parámetros obligatorios' using errcode='22023'; end if;

 -- Existing validation trigger rejects wrong or inactive roles on upsert.
 insert into public.cardiolink_secretaria_medicos (secretaria_user_id,medico_user_id,activo)
 values(p_secretaria_user_id,p_medico_user_id,p_activo)
 on conflict(secretaria_user_id,medico_user_id) do update set activo=excluded.activo;

 return jsonb_build_object('ok',true,'activo',p_activo);
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_asociar_secretaria_medico_v1(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_asociar_secretaria_medico_v1(uuid, uuid, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_listar_asociaciones_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_result jsonb;
begin
 if auth.uid() is null or not exists(
   select 1 from public.cardiolink_user_roles r
    where r.user_id=auth.uid() and r.active and r.base_role in ('owner','admin')
 ) then raise exception 'Sin permiso para ver asociaciones' using errcode='42501'; end if;

 select jsonb_build_object(
   'usuarios',coalesce((
     select jsonb_agg(jsonb_build_object('user_id',u.user_id,'usuario',u.cardiolink_user_key,
       'rol',u.base_role,'profesional_id',u.professional_id) order by u.base_role,u.cardiolink_user_key)
     from public.cardiolink_user_roles u
     where u.active and u.base_role in ('owner','medico','secretaria')
   ),'[]'::jsonb),
   'asociaciones',coalesce((
     select jsonb_agg(jsonb_build_object('secretaria_user_id',m.secretaria_user_id,
       'medico_user_id',m.medico_user_id,'activo',m.activo) order by m.secretaria_user_id,m.medico_user_id)
     from public.cardiolink_secretaria_medicos m
   ),'[]'::jsonb)
 ) into v_result;
 return v_result;
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_listar_asociaciones_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_listar_asociaciones_v1() TO authenticated, service_role;

CREATE TRIGGER cardiolink_validar_asociacion_secretaria_medico_v1 BEFORE INSERT OR UPDATE ON public.cardiolink_secretaria_medicos FOR EACH ROW EXECUTE FUNCTION public.cardiolink_validar_asociacion_secretaria_medico_v1();
CREATE TRIGGER cardiolink_secretaria_medicos_auditar_v1 AFTER INSERT OR UPDATE ON public.cardiolink_secretaria_medicos FOR EACH ROW EXECUTE FUNCTION public.cardiolink_auditar_secretaria_medico_v1();

COMMENT ON TABLE public.cardiolink_secretaria_medicos IS 'Seguridad clínica V1: asociaciones secretaria-médico. Sin acceso directo de authenticated; se gestionan con cardiolink_asociar_secretaria_medico_v1 (owner/admin).';
COMMENT ON TABLE public.cardiolink_secretaria_medicos_eventos_v1 IS 'Auditoría de cambios de asociaciones secretaria-médico (actor = auth.uid()).';

-- Postcondiciones
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.cardiolink_secretaria_medicos'::regclass AND NOT tgisinternal) <> 2 THEN RAISE EXCEPTION 'Postcondición: faltan triggers de asociaciones'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.cardiolink_secretaria_medicos'::regclass) THEN RAISE EXCEPTION 'Postcondición: RLS apagada en asociaciones'; END IF;
  IF has_table_privilege('authenticated','public.cardiolink_secretaria_medicos','SELECT') OR has_table_privilege('anon','public.cardiolink_secretaria_medicos','SELECT')
     OR has_function_privilege('anon','public.cardiolink_listar_asociaciones_v1()','EXECUTE') THEN RAISE EXCEPTION 'Postcondición: anon/authenticated no deben tocar las tablas ni anon las RPC'; END IF;
  IF NOT has_function_privilege('authenticated','public.cardiolink_asociar_secretaria_medico_v1(uuid,uuid,boolean)','EXECUTE') THEN RAISE EXCEPTION 'Postcondición: authenticated debe poder llamar la RPC (valida owner/admin adentro)'; END IF;
END $$;

-- ---------- p2 ----------
-- CardioLink · Seguridad clínica V1 · PARTE 2 · Acceso clínico médico–paciente (Bloque 4: vínculo manual + predicado)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md

DO $$
BEGIN
  IF to_regclass('public.cardiolink_pacientes') IS NULL OR to_regclass('public.cardiolink_hc_evoluciones') IS NULL OR to_regclass('public.cardiolink_atenciones') IS NULL OR to_regclass('public.cardiolink_user_roles') IS NULL THEN
    RAISE EXCEPTION 'Precondición: faltan cardiolink_pacientes / cardiolink_hc_evoluciones / cardiolink_atenciones / cardiolink_user_roles'; END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_pacientes' AND column_name='id') IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'Precondición: cardiolink_pacientes.id debe ser text'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1()'; END IF;
  IF to_regclass('public.cardiolink_paciente_profesionales_v1') IS NOT NULL OR to_regclass('public.cardiolink_paciente_profesionales_eventos_v1') IS NOT NULL OR to_regprocedure('public.cardiolink_auditar_paciente_profesional_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_asociar_paciente_profesional_v1(text, text, text, boolean)') IS NOT NULL OR to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NOT NULL THEN RAISE EXCEPTION 'La PARTE 2 (acceso clínico) ya está aplicado (o parcialmente): no se repite'; END IF;
END $$;

CREATE TABLE public.cardiolink_paciente_profesionales_v1 (
  paciente_id text NOT NULL,
  profesional_id text NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  motivo text NOT NULL,
  actualizado_por uuid NOT NULL,
  actualizado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cardiolink_paciente_profesionales_v1_pkey PRIMARY KEY (paciente_id, profesional_id),
  CONSTRAINT cardiolink_paciente_profesionales_v1_actualizado_por_fkey FOREIGN KEY (actualizado_por) REFERENCES auth.users(id),
  CONSTRAINT cardiolink_paciente_profesionales_v1_paciente_id_fkey FOREIGN KEY (paciente_id) REFERENCES public.cardiolink_pacientes(id) ON DELETE CASCADE,
  CONSTRAINT cppv1_motivo_length CHECK (((char_length(btrim(motivo)) >= 10) AND (char_length(btrim(motivo)) <= 300))),
  CONSTRAINT cppv1_prof_format CHECK ((profesional_id ~ '^[a-z0-9_.-]{1,64}$'::text))
);
ALTER TABLE public.cardiolink_paciente_profesionales_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cardiolink_paciente_profesionales_v1 FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cardiolink_paciente_profesionales_v1 TO service_role;

CREATE TABLE public.cardiolink_paciente_profesionales_eventos_v1 (
  id bigint GENERATED ALWAYS AS IDENTITY,
  paciente_id text NOT NULL,
  profesional_id text NOT NULL,
  activo_anterior boolean,
  activo_nuevo boolean NOT NULL,
  motivo text NOT NULL,
  actor uuid NOT NULL,
  registrado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT cardiolink_paciente_profesionales_eventos_v1_pkey PRIMARY KEY (id)
);
ALTER TABLE public.cardiolink_paciente_profesionales_eventos_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cardiolink_paciente_profesionales_eventos_v1 FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.cardiolink_paciente_profesionales_eventos_v1 TO service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_auditar_paciente_profesional_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
 insert into public.cardiolink_paciente_profesionales_eventos_v1
 (paciente_id,profesional_id,activo_anterior,activo_nuevo,motivo,actor)
 values(new.paciente_id,new.profesional_id,case when tg_op='UPDATE' then old.activo else null end,
 new.activo,new.motivo,new.actualizado_por);
 return new;
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_auditar_paciente_profesional_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_auditar_paciente_profesional_v1() TO service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_asociar_paciente_profesional_v1(p_paciente_id text, p_profesional_id text, p_motivo text, p_activo boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_prof text := lower(btrim(coalesce(p_profesional_id,'')));
begin
 if auth.uid() is null or not exists (
   select 1 from public.cardiolink_user_roles r
    where r.user_id=auth.uid() and r.active and r.base_role in ('owner','admin')
 ) then raise exception 'Sin permiso para gestionar vínculos clínicos' using errcode='42501'; end if;

 if nullif(btrim(coalesce(p_paciente_id,'')),'') is null
    or not exists (select 1 from public.cardiolink_pacientes where id=p_paciente_id)
 then raise exception 'Paciente inexistente' using errcode='22023'; end if;

 if v_prof !~ '^[a-z0-9_.-]{1,64}$'
    or not exists(
     select 1 from public.cardiolink_user_roles r
      where r.active and r.base_role in ('owner','medico')
        and lower(btrim(r.professional_id))=v_prof
    )
 then raise exception 'Profesional sin identidad validada' using errcode='22023'; end if;

 if p_motivo is null or char_length(btrim(p_motivo)) not between 10 and 300
 then raise exception 'Motivo obligatorio entre 10 y 300 caracteres' using errcode='22023'; end if;
 if p_activo is null then raise exception 'Estado obligatorio' using errcode='22023'; end if;

 insert into public.cardiolink_paciente_profesionales_v1
      (paciente_id,profesional_id,activo,motivo,actualizado_por,actualizado_en)
 values(p_paciente_id,v_prof,p_activo,btrim(p_motivo),auth.uid(),now())
 on conflict (paciente_id,profesional_id) do update set
    activo=excluded.activo,motivo=excluded.motivo,
    actualizado_por=excluded.actualizado_por,actualizado_en=now();
 return jsonb_build_object('ok',true,'activo',p_activo);
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_asociar_paciente_profesional_v1(text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_asociar_paciente_profesional_v1(text, text, text, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cardiolink_paciente_acceso_clinico_v1(p_paciente_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_usuario uuid := auth.uid(); v_rol text; v_prof text;
begin
 if v_usuario is null or nullif(btrim(p_paciente_id),'') is null then return false; end if;
 select r.base_role,nullif(lower(btrim(r.professional_id)),'')
   into v_rol,v_prof from public.cardiolink_user_roles r
  where r.user_id=v_usuario and r.active;
 if v_rol is null then return false; end if;
 if v_rol in ('owner','admin') then
   return exists(select 1 from public.cardiolink_pacientes p where p.id=p_paciente_id);
 end if;
 if v_rol <> 'medico' or v_prof is null then return false; end if;
 if not exists(select 1 from public.cardiolink_pacientes p where p.id=p_paciente_id) then return false; end if;
 return exists(
   select 1 from public.cardiolink_paciente_profesionales_v1 m
    where m.paciente_id=p_paciente_id and m.profesional_id=v_prof and m.activo
 ) or exists(
   select 1 from public.cardiolink_hc_evoluciones e
    where e.paciente_id=p_paciente_id and lower(btrim(e.profesional_id))=v_prof
 ) or exists(
   select 1 from public.cardiolink_atenciones a
    where a.payload->>'pacienteId'=p_paciente_id
      and lower(btrim(a.payload->>'profesionalId'))=v_prof
 );
end;
$function$;
REVOKE ALL ON FUNCTION public.cardiolink_paciente_acceso_clinico_v1(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_paciente_acceso_clinico_v1(text) TO authenticated, service_role;

CREATE TRIGGER cardiolink_paciente_profesionales_audit_v1 AFTER INSERT OR UPDATE ON public.cardiolink_paciente_profesionales_v1 FOR EACH ROW EXECUTE FUNCTION public.cardiolink_auditar_paciente_profesional_v1();

COMMENT ON TABLE public.cardiolink_paciente_profesionales_v1 IS 'Seguridad clínica V1: vínculo clínico manual paciente-profesional; se gestiona con cardiolink_asociar_paciente_profesional_v1 (owner/admin).';
COMMENT ON TABLE public.cardiolink_paciente_profesionales_eventos_v1 IS 'Auditoría de vínculos clínicos manuales paciente-profesional.';
COMMENT ON FUNCTION public.cardiolink_paciente_acceso_clinico_v1(text) IS 'Seguridad clínica V1: acceso clínico por rol del backend y vínculo documentado paciente-profesional (asociación manual activa, evolución o atención). Lo evalúan las políticas de HC y de documentos.';

-- Postcondiciones
DO $$
BEGIN
  IF has_table_privilege('authenticated','public.cardiolink_paciente_profesionales_v1','SELECT') OR has_table_privilege('anon','public.cardiolink_paciente_profesionales_v1','SELECT') THEN RAISE EXCEPTION 'Postcondición: anon/authenticated no deben tocar la tabla de vínculos'; END IF;
  IF NOT has_function_privilege('authenticated','public.cardiolink_paciente_acceso_clinico_v1(text)','EXECUTE') OR has_function_privilege('anon','public.cardiolink_paciente_acceso_clinico_v1(text)','EXECUTE') THEN RAISE EXCEPTION 'Postcondición: permisos de cardiolink_paciente_acceso_clinico_v1'; END IF;
  IF (SELECT prorettype FROM pg_proc WHERE oid='public.cardiolink_paciente_acceso_clinico_v1(text)'::regprocedure) <> 'boolean'::regtype THEN RAISE EXCEPTION 'Postcondición: acceso_clinico debe devolver boolean'; END IF;
END $$;

-- ---------- 4B-A ----------
-- CardioLink · Seguridad clínica V1 / Bloque 4B · ETAPA A (aditiva): RPC de configuración administrativa para Secretaría  (v3, tras segunda revisión técnica)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. SOLO STAGING (yslhwdlzdknhskawqrtv) hasta nueva decisión.
-- Rollback: pending_review_config_secretaria_v1_a_rpc_rollback.sql. Pruebas: pending_review_config_secretaria_v1_tests.sql. Checks: …_checks.sql.
-- SIN EJECUTAR: no se pudo validar la sintaxis contra una base (no hay Postgres local); revisar con el SQL Editor de STAGING antes de confiar.
--
-- PROBLEMA. La fila `__cardiolink_config_v1` de cardiolink_atenciones guarda el objeto `data` completo de la app (evoluciones, resúmenes,
-- documentos, notas internas, finanzas…) y la política cardiolink_atencion_permitida_v2 deja leerla y escribirla a Secretaría.
--
-- QUÉ AGREGA ESTA ETAPA (no cambia ninguna política ni dato; el comportamiento actual no cambia hasta la ETAPA B):
--   1) cardiolink_config_administrativa_v1()  → devuelve SÓLO lo permitido a Secretaría (más `updated_at` y un hash de la parte escribible).
--   2) cardiolink_guardar_config_administrativa_v1(config, base_updated_at, base_hash, uid_esperado) → aplica SÓLO lo permitido, FUSIONÁNDOLO con la fila existente.
--      uid_esperado (cambio de sesión): OBLIGATORIO y sin DEFAULT. El cliente manda el id del usuario que INICIÓ el guardado. NULL → 22023 (HINT 'UID_ESPERADO_OBLIGATORIO');
--      omitido → 42883 (la firma de 3 argumentos no existe); distinto de auth.uid() (cierre de sesión, otro usuario en otra pestaña) → 42501 (HINT 'SESION_DISTINTA').
--      En los tres casos no se escribe nada.
--      Todo lo demás se conserva idéntico, byte a byte. Control de concurrencia con updated_at (+ hash). Sin fallback: si falla, falla (el cliente lo muestra).
--   Ambas son SECURITY DEFINER, sólo ejecutables por `authenticated`, y exigen rol backend ACTIVO = 'secretaria' (owner/admin/médico: 42501).
--
-- LISTAS EXPLÍCITAS (fail-closed). Hay dos niveles: claves superiores Y campos anidados.
--   CLAVES SUPERIORES
--     LECTURA : catálogos, convenios/aranceles, profesionales, pacientes, usuarios, roles, etc. + documentosClinicos FILTRADO (ver abajo).
--     ESCRITURA = LECTURA menos {usuarios, roles, brandingCardioLink, migracionesCardioLink, documentosClinicos}.
--     NUNCA: evolucionesClinicas, resumenesClinicos, importacionesMedicloudEvoluciones, notasInternasMedicas, notasInternasPorProfesional,
--            configFinanzas411F, movimientosFinancieros411C, hcPreparacion, integracionesClinicas, identidadesArchivadas y toda clave desconocida.
--   CAMPOS ANIDADOS
--     pacientes[]      : 27 campos administrativos (CAMPOS_PACIENTE). Lectura y escritura. Cualquier otro campo del paciente NO se lee ni se escribe;
--                        en un paciente existente se conserva tal cual (la fusión parte del elemento existente).
--     profesionales[]  : escritura SÓLO de CAMPOS_PROFESIONAL_ADMIN (id, nombre, area, prestaciones, valores, especialidadIds, bloquesPrestaciones, activo).
--                        Lectura: esos + las 12 claves de IDENTIDAD documental (Secretaría las necesita para imprimir documentos que emite, pero NUNCA se escriben).
--                        Firmas, logos, matrículas y demás identidad: imposibles de alterar por esta RPC (se parte del elemento existente y sólo se pisan los campos admin).
--     documentosClinicos[]: LECTURA de los documentos cuyo `tipo` está en TIPOS_DOC_SECRETARIA (hoy sólo 'constancia_atencion'); NUNCA escritura.
--                        Los documentos nuevos se archivan en cardiolink_patient_documents (Documentos V1) y el cliente los sincroniza desde ahí. Los documentos heredados
--                        (13 en STAGING; sólo 2 con source_document_id confirmado) quedan INTACTOS en la fila: esta RPC no los modifica nunca.
--   (tests/config-secretaria-v1.js verifica que las listas del cliente y las de este archivo coincidan y que toda clave `data.<x>` del código esté clasificada.)
--
-- REGLAS DE FUSIÓN (escritura):
--   * Clave ausente → se deja como está. Valor null o de distinto tipo JSON que el existente → se RECHAZA (22023).
--   * pacientes / profesionales / obrasSociales: arreglo vacío sobre uno no vacío → se RECHAZA (anti-vaciado accidental).
--   * pacientes: por id; elementos sin id, no-objeto o con id duplicado → 22023. Quitar un paciente que tiene historia clínica asociada (filas en
--     cardiolink_hc_evoluciones/hc_resumen o referencias en las claves clínicas heredadas) → 42501. Elementos heredados sin id utilizable se conservan.
--   * profesionales: por id. Quitar uno con identidad documental cargada → 42501 (lo hace el dueño). Un profesional nuevo entra sin identidad.
--   * auditoriaPacientes: sólo se AGREGAN elementos nuevos.
--   * Se conservan payload.tipoRegistro y payload.version; se actualiza payload.updatedAt y la columna updated_at.
-- CONCURRENCIA. El cliente manda el `updated_at` y el `vista_hash` que recibió al leer. El hash cubre SÓLO lo que Secretaría puede sobrescribir (claves de
--   escritura con sus campos anidados permitidos). Si la fila cambió (updated_at distinto) Y ese contenido también (hash distinto) → {ok:false, conflict:true}
--   sin escribir nada. Si la fila cambió por escrituras clínicas, de identidad o de usuarios (hash igual), se acepta: evita conflictos falsos.
--   La fila se bloquea (FOR UPDATE). El cliente serializa sus llamadas para no competir contra sí mismo.
-- No modifica: tablas, columnas, políticas RLS, triggers, datos ni otras funciones. No borra nada.
-- Interacción con el trigger de identidad (cardiolink_atenciones_proteger_identidad_v1, si está aplicado): el UPDATE de estas RPC corre como el dueño de la
--   función (no authenticated), por lo que el trigger no interviene; la identidad se protege acá preservándola.


DO $$
DECLARE v_tipo text;
BEGIN
  IF to_regclass('public.cardiolink_atenciones') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_atenciones'; END IF;
  IF to_regclass('public.cardiolink_user_roles') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_user_roles'; END IF;
  IF to_regclass('public.cardiolink_hc_evoluciones') IS NULL OR to_regclass('public.cardiolink_hc_resumen') IS NULL THEN
    RAISE EXCEPTION 'Precondición: faltan las tablas de HC relacional (cardiolink_hc_evoluciones / cardiolink_hc_resumen)'; END IF;
  SELECT data_type INTO v_tipo FROM information_schema.columns
   WHERE table_schema='public' AND table_name='cardiolink_atenciones' AND column_name='updated_at';
  IF v_tipo IS DISTINCT FROM 'timestamp with time zone' THEN
    RAISE EXCEPTION 'Precondición: cardiolink_atenciones.updated_at debe ser timestamptz (es %)', v_tipo; END IF;
  IF (SELECT relforcerowsecurity FROM pg_class WHERE oid='public.cardiolink_atenciones'::regclass) THEN
    RAISE EXCEPTION 'Precondición: cardiolink_atenciones tiene FORCE ROW LEVEL SECURITY; las RPC SECURITY DEFINER no podrían actualizar la fila'; END IF;
  IF (SELECT count(*) FROM public.cardiolink_atenciones WHERE id='__cardiolink_config_v1') <> 1 THEN
    RAISE EXCEPTION 'Precondición: debe existir exactamente una fila __cardiolink_config_v1'; END IF;
  IF to_regprocedure('public.cardiolink_config_administrativa_v1()') IS NOT NULL
     OR to_regprocedure('public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Las RPC ya existen: no se repite esta etapa'; END IF;
END $$;

-- ===== 1) Listas explícitas (internas; sin acceso de authenticated) =====
CREATE FUNCTION public.cardiolink_config_claves_lectura_sec_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- CLAVES_LECTURA_INICIO
  'profesionales','especialidades','obrasSociales','reglasOS','pacientes','usuarios','roles','colocadores',
  'medicosDerivantes','motivosConsulta','bloquesPrestaciones','bloquesPrestacionesLabels','horariosProfesionales',
  'arancelesPorProfesional','conveniosPorProfesional','conveniosFacturacion','arancelesConvenios','plantillasPedidos',
  'duracionesPrestacion','catalogoPrestaciones411P','destinosFacturacion','brandingCardioLink','auditoriaPacientes',
  'migracionesCardioLink','documentosClinicos'
  -- CLAVES_LECTURA_FIN
 ]::text[]
$f$;

CREATE FUNCTION public.cardiolink_config_claves_escritura_sec_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- CLAVES_ESCRITURA_INICIO
  'profesionales','especialidades','obrasSociales','reglasOS','pacientes','colocadores',
  'medicosDerivantes','motivosConsulta','bloquesPrestaciones','bloquesPrestacionesLabels','horariosProfesionales',
  'arancelesPorProfesional','conveniosPorProfesional','conveniosFacturacion','arancelesConvenios','plantillasPedidos',
  'duracionesPrestacion','catalogoPrestaciones411P','destinosFacturacion','auditoriaPacientes'
  -- CLAVES_ESCRITURA_FIN
 ]::text[]
$f$;

-- Claves de identidad documental del profesional (las mismas 12 que protege el trigger de identidad y escribe cardiolink_guardar_identidad_profesional_v1).
CREATE FUNCTION public.cardiolink_config_claves_identidad_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- CAMPOS_IDENTIDAD_INICIO
  'marcaDocumento','logoDocumento','logoDocumentoData','firmaDocumentoData','matriculaNacional','matriculaProvincial',
  'telefonoDocumento','emailDocumento','direccionDocumento','redesDocumento','colorDocumento','mostrarFirmaDocumento'
  -- CAMPOS_IDENTIDAD_FIN
 ]::text[]
$f$;

-- Campos administrativos de cada elemento de pacientes[] (lectura y escritura). Estructura relevada de aplicarPaciente298, pacienteRow410, mergePaciente410 y fusionarPacientes.
CREATE FUNCTION public.cardiolink_config_campos_paciente_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- CAMPOS_PACIENTE_INICIO
  'id','nombreCompleto','dni','sexo','telefono','email','fechaNacimiento','localidad','direccion','provincia',
  'coberturaHabitual','numeroAfiliadoHabitual','historialCoberturas','contactoResponsableNombre','contactoResponsableRelacion',
  'contactoResponsableTelefono','contactoResponsableEmail','observacionesAdministrativas','estado','fusionadoCon','fusionadoEn',
  'fusionadoPor','creadoEn','creadoPor','actualizadoEn','actualizadoPor','creadoPorImportacionLote'
  -- CAMPOS_PACIENTE_FIN
 ]::text[]
$f$;

-- Campos administrativos de cada elemento de profesionales[] que Secretaría puede ESCRIBIR (la identidad documental nunca).
CREATE FUNCTION public.cardiolink_config_campos_profesional_admin_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- CAMPOS_PROFESIONAL_INICIO
  'id','nombre','area','prestaciones','valores','especialidadIds','bloquesPrestaciones','activo'
  -- CAMPOS_PROFESIONAL_FIN
 ]::text[]
$f$;

-- Tipos de documento heredado que Secretaría puede LEER (sólo lectura; nunca se escriben por esta vía).
CREATE FUNCTION public.cardiolink_config_tipos_doc_sec_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY[
  -- TIPOS_DOC_INICIO
  'constancia_atencion'
  -- TIPOS_DOC_FIN
 ]::text[]
$f$;

-- ===== 2) Filtros y vistas =====
-- Cada elemento-objeto de un arreglo, reducido a los campos indicados (los que no son objeto se descartan).
CREATE FUNCTION public.cardiolink_config_filtrar_objetos_v1(p_arr jsonb, p_campos text[])
 RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT coalesce(jsonb_agg(s.f ORDER BY s.ord), '[]'::jsonb)
   FROM (SELECT e.ord,
                coalesce((SELECT jsonb_object_agg(k, e.p -> k) FROM unnest(p_campos) AS k WHERE e.p ? k), '{}'::jsonb) AS f
           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_arr) = 'array' THEN p_arr ELSE '[]'::jsonb END) WITH ORDINALITY AS e(p, ord)
          WHERE jsonb_typeof(e.p) = 'object') s
$f$;

-- Vista de LECTURA: sólo las claves de lectura; pacientes y profesionales con campos anidados filtrados; documentos filtrados por tipo.
CREATE FUNCTION public.cardiolink_config_vista_sec_v1(p_config jsonb)
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

-- Vista de ESCRITURA (para el hash de concurrencia): lo que Secretaría puede sobrescribir, con los campos anidados permitidos.
CREATE FUNCTION public.cardiolink_config_vista_escritura_sec_v1(p_config jsonb)
 RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT coalesce(jsonb_object_agg(k,
          CASE
            WHEN k = 'pacientes' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k, public.cardiolink_config_campos_paciente_v1())
            WHEN k = 'profesionales' AND jsonb_typeof(p_config -> k) = 'array'
              THEN public.cardiolink_config_filtrar_objetos_v1(p_config -> k, public.cardiolink_config_campos_profesional_admin_v1())
            ELSE p_config -> k
          END) FILTER (WHERE p_config ? k), '{}'::jsonb)
   FROM unnest(public.cardiolink_config_claves_escritura_sec_v1()) AS k
$f$;

-- ¿El paciente tiene historia clínica asociada? (tablas relacionales o claves clínicas heredadas). Se usa para impedir que Secretaría lo quite.
CREATE FUNCTION public.cardiolink_config_paciente_con_clinica_v1(p_cfg jsonb, p_id text)
 RETURNS boolean LANGUAGE sql STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $f$
 SELECT EXISTS (SELECT 1 FROM public.cardiolink_hc_evoluciones r WHERE r.paciente_id = p_id)
     OR EXISTS (SELECT 1 FROM public.cardiolink_hc_resumen r WHERE r.paciente_id = p_id)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_cfg -> 'evolucionesClinicas') = 'array' THEN p_cfg -> 'evolucionesClinicas' ELSE '[]'::jsonb END) e(x)
                 WHERE e.x ->> 'pacienteId' = p_id)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_cfg -> 'documentosClinicos') = 'array' THEN p_cfg -> 'documentosClinicos' ELSE '[]'::jsonb END) e(x)
                 WHERE e.x ->> 'pacienteId' = p_id)
     OR (CASE WHEN jsonb_typeof(p_cfg -> 'resumenesClinicos') = 'object' THEN (p_cfg -> 'resumenesClinicos') ? p_id ELSE false END)
$f$;

-- ===== 3) Fusiones anidadas =====
-- pacientes: parte del elemento EXISTENTE y pisa sólo los campos administrativos enviados; un paciente nuevo entra sólo con campos administrativos.
CREATE FUNCTION public.cardiolink_config_fusionar_pacientes_v1(p_old jsonb, p_in jsonb, p_cfg jsonb)
 RETURNS jsonb LANGUAGE plpgsql STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE
  c_campos constant text[] := public.cardiolink_config_campos_paciente_v1();
  v_old    jsonb := CASE WHEN jsonb_typeof(p_old) = 'array' THEN p_old ELSE '[]'::jsonb END;
  v_res    jsonb;
  v_o      jsonb;
BEGIN
  IF jsonb_typeof(p_in) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'pacientes debe ser un arreglo' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) e(p) WHERE jsonb_typeof(e.p) <> 'object' OR nullif(e.p ->> 'id', '') IS NULL) THEN
    RAISE EXCEPTION 'pacientes: todos los elementos deben ser objetos con id' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) e(p) GROUP BY e.p ->> 'id' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'pacientes: ids duplicados' USING ERRCODE = '22023'; END IF;
  -- bajas: no se quita un paciente con historia clínica asociada
  FOR v_o IN
    SELECT o.p FROM jsonb_array_elements(v_old) o(p)
     WHERE jsonb_typeof(o.p) = 'object' AND nullif(o.p ->> 'id', '') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) n(p) WHERE n.p ->> 'id' = o.p ->> 'id')
  LOOP
    IF public.cardiolink_config_paciente_con_clinica_v1(p_cfg, v_o ->> 'id') THEN
      RAISE EXCEPTION 'No se puede quitar el paciente % desde Secretaría: tiene historia clínica asociada (lo hace el dueño)', v_o ->> 'id' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(m.x ORDER BY m.ord), '[]'::jsonb) INTO v_res
    FROM (SELECT n.ord,
                 coalesce(o.p, '{}'::jsonb)
                 || coalesce((SELECT jsonb_object_agg(k, n.p -> k) FROM unnest(c_campos) AS k WHERE n.p ? k), '{}'::jsonb) AS x
            FROM jsonb_array_elements(p_in) WITH ORDINALITY AS n(p, ord)
            LEFT JOIN LATERAL (SELECT oo.p FROM jsonb_array_elements(v_old) AS oo(p)
                                WHERE jsonb_typeof(oo.p) = 'object' AND oo.p ->> 'id' = n.p ->> 'id' LIMIT 1) AS o ON true) m;
  -- elementos heredados sin id utilizable: se conservan al final (no se elimina nada que Secretaría no pueda ver)
  v_res := v_res || coalesce((SELECT jsonb_agg(o.p ORDER BY o.ord)
                                FROM jsonb_array_elements(v_old) WITH ORDINALITY AS o(p, ord)
                               WHERE jsonb_typeof(o.p) <> 'object' OR nullif(o.p ->> 'id', '') IS NULL), '[]'::jsonb);
  RETURN v_res;
END
$f$;

-- profesionales: parte del elemento EXISTENTE y pisa sólo los campos administrativos enviados; la identidad documental no se toca nunca.
CREATE FUNCTION public.cardiolink_config_fusionar_profesionales_v1(p_old jsonb, p_in jsonb)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE
  c_ident  constant text[] := public.cardiolink_config_claves_identidad_v1();
  c_campos constant text[] := public.cardiolink_config_campos_profesional_admin_v1();
  v_old    jsonb := CASE WHEN jsonb_typeof(p_old) = 'array' THEN p_old ELSE '[]'::jsonb END;
  v_res    jsonb;
  v_o      jsonb;
BEGIN
  IF jsonb_typeof(p_in) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'profesionales debe ser un arreglo' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) e(p) WHERE jsonb_typeof(e.p) <> 'object' OR nullif(e.p ->> 'id', '') IS NULL) THEN
    RAISE EXCEPTION 'profesionales: todos los elementos deben ser objetos con id' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) e(p) GROUP BY e.p ->> 'id' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'profesionales: ids duplicados' USING ERRCODE = '22023'; END IF;
  -- no se quita un profesional que tiene identidad documental cargada
  FOR v_o IN
    SELECT o.p FROM jsonb_array_elements(v_old) o(p)
     WHERE jsonb_typeof(o.p) = 'object' AND nullif(o.p ->> 'id', '') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_in) n(p) WHERE n.p ->> 'id' = o.p ->> 'id')
  LOOP
    IF EXISTS (SELECT 1 FROM unnest(c_ident) k WHERE jsonb_typeof(v_o -> k) = 'string' AND (v_o ->> k) <> '') THEN
      RAISE EXCEPTION 'No se puede quitar el profesional % desde Secretaría: tiene identidad documental cargada (lo hace el dueño)', v_o ->> 'id'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(m.x ORDER BY m.ord), '[]'::jsonb) INTO v_res
    FROM (SELECT n.ord,
                 coalesce(o.p, '{}'::jsonb)
                 || coalesce((SELECT jsonb_object_agg(k, n.p -> k) FROM unnest(c_campos) AS k WHERE n.p ? k), '{}'::jsonb) AS x
            FROM jsonb_array_elements(p_in) WITH ORDINALITY AS n(p, ord)
            LEFT JOIN LATERAL (SELECT oo.p FROM jsonb_array_elements(v_old) AS oo(p)
                                WHERE jsonb_typeof(oo.p) = 'object' AND oo.p ->> 'id' = n.p ->> 'id' LIMIT 1) AS o ON true) m;
  v_res := v_res || coalesce((SELECT jsonb_agg(o.p ORDER BY o.ord)
                                FROM jsonb_array_elements(v_old) WITH ORDINALITY AS o(p, ord)
                               WHERE jsonb_typeof(o.p) <> 'object' OR nullif(o.p ->> 'id', '') IS NULL), '[]'::jsonb);
  RETURN v_res;
END
$f$;

-- auditoriaPacientes: conserva los existentes (y su orden) y agrega los nuevos.
CREATE FUNCTION public.cardiolink_config_unir_auditoria_v1(p_old jsonb, p_in jsonb)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE
  v_old jsonb := CASE WHEN jsonb_typeof(p_old) = 'array' THEN p_old ELSE '[]'::jsonb END;
BEGIN
  IF jsonb_typeof(p_in) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'auditoriaPacientes debe ser un arreglo' USING ERRCODE = '22023'; END IF;
  RETURN v_old || coalesce((SELECT jsonb_agg(e.x ORDER BY e.ord)
                              FROM jsonb_array_elements(p_in) WITH ORDINALITY AS e(x, ord)
                             WHERE NOT (v_old @> jsonb_build_array(e.x))), '[]'::jsonb);
END
$f$;

-- ===== 4) RPC de lectura =====
CREATE FUNCTION public.cardiolink_config_administrativa_v1()
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE
  v_row public.cardiolink_atenciones%ROWTYPE;
  v_cfg jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.cardiolink_user_roles r
                                        WHERE r.user_id = auth.uid() AND r.active IS TRUE AND r.base_role = 'secretaria') THEN
    RAISE EXCEPTION 'Sin permiso para ver la configuración administrativa' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.cardiolink_atenciones WHERE id = '__cardiolink_config_v1';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'config', NULL, 'updated_at', NULL, 'vista_hash', NULL);
  END IF;
  v_cfg := CASE WHEN jsonb_typeof(v_row.payload -> 'config') = 'object' THEN v_row.payload -> 'config' ELSE '{}'::jsonb END;
  RETURN jsonb_build_object('ok', true, 'config', public.cardiolink_config_vista_sec_v1(v_cfg), 'updated_at', v_row.updated_at::text,
                            'vista_hash', md5(public.cardiolink_config_vista_escritura_sec_v1(v_cfg)::text), 'version', v_row.payload -> 'version');
END
$f$;

-- ===== 5) RPC de escritura =====
CREATE FUNCTION public.cardiolink_guardar_config_administrativa_v1(p_config jsonb, p_base_updated_at text, p_base_hash text, p_uid_esperado uuid)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $f$
DECLARE
  v_row     public.cardiolink_atenciones%ROWTYPE;
  v_cfg     jsonb;
  v_new     jsonb;
  v_in      jsonb;
  v_old     jsonb;
  v_hash    text;
  v_base_ts timestamptz;
  v_now     timestamptz := clock_timestamp();
  v_upd     timestamptz;
  k         text;
BEGIN
  -- Cambio de sesión (v3.1): p_uid_esperado es OBLIGATORIO (sin DEFAULT: omitirlo = la función no existe para esa llamada, 42883) y no puede ser NULL.
  -- La operación pertenece al usuario que la inició: si el token que llega es de otro usuario (o no hay sesión), no se escribe.
  IF p_uid_esperado IS NULL THEN
    RAISE EXCEPTION 'Falta el usuario que inició el guardado (p_uid_esperado)' USING ERRCODE = '22023', HINT = 'UID_ESPERADO_OBLIGATORIO';
  END IF;
  IF auth.uid() IS NULL OR p_uid_esperado IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'La sesión que inició este guardado ya no es la activa: no se guardó nada' USING ERRCODE = '42501', HINT = 'SESION_DISTINTA';
  END IF;
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.cardiolink_user_roles r
                                        WHERE r.user_id = auth.uid() AND r.active IS TRUE AND r.base_role = 'secretaria') THEN
    RAISE EXCEPTION 'Sin permiso para guardar la configuración administrativa' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'La configuración debe ser un objeto' USING ERRCODE = '22023'; END IF;
  IF p_base_updated_at IS NULL OR btrim(p_base_updated_at) = '' THEN
    RAISE EXCEPTION 'Falta la versión base (updated_at) de la configuración' USING ERRCODE = '22023'; END IF;
  BEGIN v_base_ts := p_base_updated_at::timestamptz;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'Versión base inválida' USING ERRCODE = '22023'; END;

  SELECT * INTO v_row FROM public.cardiolink_atenciones WHERE id = '__cardiolink_config_v1' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'sin_configuracion'); END IF;
  v_cfg  := CASE WHEN jsonb_typeof(v_row.payload -> 'config') = 'object' THEN v_row.payload -> 'config' ELSE '{}'::jsonb END;
  v_hash := md5(public.cardiolink_config_vista_escritura_sec_v1(v_cfg)::text);

  -- Concurrencia: la fila cambió Y lo que Secretaría puede sobrescribir también → conflicto, sin escribir.
  IF v_row.updated_at IS DISTINCT FROM v_base_ts AND v_hash IS DISTINCT FROM p_base_hash THEN
    RETURN jsonb_build_object('ok', false, 'conflict', true, 'updated_at', v_row.updated_at::text, 'vista_hash', v_hash);
  END IF;

  v_new := v_cfg;
  FOREACH k IN ARRAY public.cardiolink_config_claves_escritura_sec_v1() LOOP
    CONTINUE WHEN NOT (p_config ? k);
    v_in  := p_config -> k;
    v_old := v_cfg -> k;
    IF jsonb_typeof(v_in) IS NULL OR jsonb_typeof(v_in) = 'null' THEN
      RAISE EXCEPTION 'La clave % no puede ser null', k USING ERRCODE = '22023'; END IF;
    IF v_old IS NOT NULL AND jsonb_typeof(v_old) <> 'null' AND jsonb_typeof(v_in) <> jsonb_typeof(v_old) THEN
      RAISE EXCEPTION 'La clave % cambia de tipo (%→%)', k, jsonb_typeof(v_old), jsonb_typeof(v_in) USING ERRCODE = '22023'; END IF;
    IF k IN ('pacientes', 'profesionales', 'obrasSociales')
       AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(v_in)  = 'array' THEN v_in  END), -1) = 0
       AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(v_old) = 'array' THEN v_old END),  0) > 0 THEN
      RAISE EXCEPTION 'La clave % llegó vacía y la configuración tiene datos: se rechaza para evitar un vaciado accidental', k USING ERRCODE = '22023'; END IF;
    IF k = 'pacientes' THEN v_in := public.cardiolink_config_fusionar_pacientes_v1(v_old, v_in, v_cfg);
    ELSIF k = 'profesionales' THEN v_in := public.cardiolink_config_fusionar_profesionales_v1(v_old, v_in);
    ELSIF k = 'auditoriaPacientes' THEN v_in := public.cardiolink_config_unir_auditoria_v1(v_old, v_in);
    END IF;
    v_new := jsonb_set(v_new, ARRAY[k], v_in, true);
  END LOOP;

  UPDATE public.cardiolink_atenciones
     SET payload = jsonb_set(jsonb_set(v_row.payload, '{config}', v_new, true), '{updatedAt}',
                             to_jsonb(to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true),
         updated_at = v_now
   WHERE id = '__cardiolink_config_v1'
   RETURNING updated_at INTO v_upd;

  RETURN jsonb_build_object('ok', true, 'updated_at', v_upd::text,
                            'vista_hash', md5(public.cardiolink_config_vista_escritura_sec_v1(v_new)::text));
END
$f$;

-- ===== 6) Privilegios =====
REVOKE ALL ON FUNCTION public.cardiolink_config_claves_lectura_sec_v1()   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_claves_escritura_sec_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_claves_identidad_v1()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_campos_paciente_v1()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_campos_profesional_admin_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_tipos_doc_sec_v1()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_filtrar_objetos_v1(jsonb,text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_vista_sec_v1(jsonb)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_vista_escritura_sec_v1(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_paciente_con_clinica_v1(jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_fusionar_pacientes_v1(jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_fusionar_profesionales_v1(jsonb,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_unir_auditoria_v1(jsonb,jsonb)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_config_administrativa_v1()                    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_config_administrativa_v1()                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid) TO authenticated;

-- ===== 7) Postcondiciones =====
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.cardiolink_config_administrativa_v1()','public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN RAISE EXCEPTION 'FALLA: anon puede ejecutar %', f; END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN RAISE EXCEPTION 'FALLA: authenticated no puede ejecutar %', f; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN RAISE EXCEPTION 'FALLA: % no es SECURITY DEFINER', f; END IF;
  END LOOP;
  IF (SELECT pronargdefaults FROM pg_proc WHERE oid = 'public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)'::regprocedure) <> 0 THEN
    RAISE EXCEPTION 'FALLA: la RPC de guardado no debe tener argumentos por defecto (p_uid_esperado es obligatorio)'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'cardiolink_guardar_config_administrativa_v1') <> 1 THEN
    RAISE EXCEPTION 'FALLA: debe existir una única firma de la RPC de guardado'; END IF;
  FOREACH f IN ARRAY ARRAY['public.cardiolink_config_claves_lectura_sec_v1()','public.cardiolink_config_claves_escritura_sec_v1()',
                           'public.cardiolink_config_claves_identidad_v1()','public.cardiolink_config_campos_paciente_v1()',
                           'public.cardiolink_config_campos_profesional_admin_v1()','public.cardiolink_config_tipos_doc_sec_v1()',
                           'public.cardiolink_config_filtrar_objetos_v1(jsonb,text[])','public.cardiolink_config_vista_sec_v1(jsonb)',
                           'public.cardiolink_config_vista_escritura_sec_v1(jsonb)','public.cardiolink_config_paciente_con_clinica_v1(jsonb,text)',
                           'public.cardiolink_config_fusionar_pacientes_v1(jsonb,jsonb,jsonb)','public.cardiolink_config_fusionar_profesionales_v1(jsonb,jsonb)',
                           'public.cardiolink_config_unir_auditoria_v1(jsonb,jsonb)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FALLA: el helper interno % es ejecutable por anon/authenticated', f; END IF;
  END LOOP;
  IF public.cardiolink_config_claves_escritura_sec_v1() <@ public.cardiolink_config_claves_lectura_sec_v1() IS NOT TRUE THEN
    RAISE EXCEPTION 'FALLA: la lista de escritura debe estar contenida en la de lectura'; END IF;
  IF 'documentosClinicos' = ANY (public.cardiolink_config_claves_escritura_sec_v1()) THEN
    RAISE EXCEPTION 'FALLA: documentosClinicos no puede ser escribible por Secretaría'; END IF;
  IF public.cardiolink_config_claves_lectura_sec_v1() && ARRAY['evolucionesClinicas','resumenesClinicos','importacionesMedicloudEvoluciones',
       'notasInternasMedicas','notasInternasPorProfesional','configFinanzas411F','movimientosFinancieros411C','hcPreparacion','integracionesClinicas','identidadesArchivadas'] THEN
    RAISE EXCEPTION 'FALLA: la lista de lectura incluye una clave restringida'; END IF;
  IF public.cardiolink_config_campos_profesional_admin_v1() && public.cardiolink_config_claves_identidad_v1() THEN
    RAISE EXCEPTION 'FALLA: un campo de identidad figura entre los campos administrativos escribibles del profesional'; END IF;
  RAISE NOTICE 'OK ETAPA A: RPC creadas, helpers internos cerrados, listas coherentes. Ninguna política ni dato se modificó.';
END $$;

-- ---------- 4B-B ----------
-- CardioLink · Seguridad clínica V1 / Bloque 4B · ETAPA B (RLS): cerrar la fila de configuración completa a Secretaría
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. SOLO STAGING (yslhwdlzdknhskawqrtv).
-- Rollback: pending_review_config_secretaria_v1_b_rls_rollback.sql. Pruebas: pending_review_config_secretaria_v1_tests.sql.
-- SIN EJECUTAR: sintaxis sin validar contra una base (no hay Postgres local).
--
-- ORDEN OBLIGATORIO. Aplicar SÓLO DESPUÉS de (1) la ETAPA A y (2) que el cliente de Secretaría con las RPC esté desplegado y verificado.
-- Si se aplica antes, un cliente viejo de Secretaría pierde el guardado de configuración (42501; el cliente viejo sólo hace console.warn).
--
-- QUÉ HACE (y nada más):
--   1) cardiolink_atencion_permitida_v2: la rama 'secretaria' deja de ser `true` y pasa a `tipoRegistro <> 'config'`.
--      Las 4 políticas existentes (SELECT/INSERT/UPDATE/DELETE) ya evalúan este predicado, así que Secretaría deja de poder leer, insertar,
--      modificar o borrar la fila de configuración por API directa (y de convertir otra fila en 'config'). Atenciones y mensajes: sin cambios.
--      owner/admin: igual que antes (true). médico: igual que antes (sin cambios de lógica).
--   2) Política RESTRICTIVA por id (cinturón y tirantes, independiente del contenido del payload): la fila '__cardiolink_config_v1' sólo es
--      accesible, por API, para owner/admin. Una política RESTRICTIVA se suma (AND) a las permisivas existentes; no abre nada.
-- Las RPC de la ETAPA A siguen funcionando: son SECURITY DEFINER (corren como dueño de la tabla, sin RLS).
-- No modifica datos, tablas, columnas, triggers, grants ni otras funciones. No borra nada. La fila de configuración y su contenido quedan intactos.
-- Efecto colateral aceptado: un cliente viejo de Secretaría (sin las RPC) deja de poder leer/guardar la config; ver riesgos en el informe.


DO $$
DECLARE v_src text; v_esperado constant text :=
  regexp_replace($e$
 SELECT CASE
   WHEN p_rol IN ('owner','admin','secretaria') THEN true
   WHEN p_rol = 'medico' THEN nullif(pg_catalog.btrim(p_prof),'') IS NOT NULL
        AND p_prof = p_payload->>'profesionalId'
        AND coalesce(p_payload->>'tipoRegistro','') NOT IN ('mensaje','config')
   ELSE false END
$e$, '\s+', '', 'g');
  n int;
BEGIN
  IF to_regprocedure('public.cardiolink_config_administrativa_v1()') IS NULL
     OR to_regprocedure('public.cardiolink_guardar_config_administrativa_v1(jsonb,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: aplicar antes la ETAPA A (RPC de configuración administrativa)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL THEN RAISE EXCEPTION 'Precondición: falta cardiolink_ctx_rol_v1()'; END IF;
  SELECT regexp_replace(prosrc, '\s+', '', 'g') INTO v_src FROM pg_proc WHERE oid = 'public.cardiolink_atencion_permitida_v2(jsonb,text,text)'::regprocedure;
  IF v_src IS DISTINCT FROM v_esperado THEN
    RAISE EXCEPTION 'Precondición: el cuerpo vigente de cardiolink_atencion_permitida_v2 no coincide con el esperado (comparar con el snapshot de la consulta 1 de la auditoría)'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
     AND (coalesce(qual,'') ~ 'cardiolink_atencion_permitida_v2' OR coalesce(with_check,'') ~ 'cardiolink_atencion_permitida_v2');
  IF n < 4 THEN RAISE EXCEPTION 'Precondición: se esperaban 4 políticas que usen cardiolink_atencion_permitida_v2 y hay %', n; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones' AND policyname='cardiolink_atenciones_config_solo_admin_v1') THEN
    RAISE EXCEPTION 'La política restrictiva ya existe: no se repite esta etapa'; END IF;
END $$;

-- ===== 1) Predicado v2 (nueva versión): Secretaría no accede a filas de configuración =====
CREATE OR REPLACE FUNCTION public.cardiolink_atencion_permitida_v2(p_payload jsonb, p_rol text, p_prof text)
 RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT CASE
   WHEN p_rol IN ('owner','admin') THEN true
   WHEN p_rol = 'secretaria' THEN coalesce(p_payload->>'tipoRegistro','') <> 'config'
   WHEN p_rol = 'medico' THEN nullif(pg_catalog.btrim(p_prof),'') IS NOT NULL
        AND p_prof = p_payload->>'profesionalId'
        AND coalesce(p_payload->>'tipoRegistro','') NOT IN ('mensaje','config')
   ELSE false END
$f$;
-- CREATE OR REPLACE conserva los GRANT existentes (EXECUTE sólo para authenticated, no anon).

-- ===== 2) Política RESTRICTIVA por id =====
CREATE POLICY cardiolink_atenciones_config_solo_admin_v1 ON public.cardiolink_atenciones
  AS RESTRICTIVE FOR ALL TO authenticated
  USING      (id <> '__cardiolink_config_v1' OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner','admin'))
  WITH CHECK (id <> '__cardiolink_config_v1' OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner','admin'));

-- ===== 3) Postcondiciones =====
DO $$
BEGIN
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config"}'::jsonb,'secretaria',NULL) IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: secretaria aún accede a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config"}'::jsonb,'owner',NULL)      IS NOT TRUE  THEN RAISE EXCEPTION 'FALLA: owner perdió acceso a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config"}'::jsonb,'admin',NULL)      IS NOT TRUE  THEN RAISE EXCEPTION 'FALLA: admin perdió acceso a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"id":"1","profesionalId":"x"}'::jsonb,'secretaria',NULL) IS NOT TRUE THEN RAISE EXCEPTION 'FALLA: secretaria perdió las atenciones'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"mensaje"}'::jsonb,'secretaria',NULL) IS NOT TRUE THEN RAISE EXCEPTION 'FALLA: secretaria perdió los mensajes'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"profesionalId":"x"}'::jsonb,'medico','x') IS NOT TRUE THEN RAISE EXCEPTION 'FALLA: médico perdió sus atenciones'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"profesionalId":"x"}'::jsonb,'medico','y') IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: médico ve atenciones ajenas'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{"tipoRegistro":"config","profesionalId":"x"}'::jsonb,'medico','x') IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: médico accede a config'; END IF;
  IF public.cardiolink_atencion_permitida_v2('{}'::jsonb,'otro','x') IS NOT FALSE THEN RAISE EXCEPTION 'FALLA: rol desconocido con acceso'; END IF;
  IF has_function_privilege('anon','public.cardiolink_atencion_permitida_v2(jsonb,text,text)','EXECUTE') THEN RAISE EXCEPTION 'FALLA: anon puede ejecutar el predicado'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_atenciones'
                  AND policyname='cardiolink_atenciones_config_solo_admin_v1' AND permissive='RESTRICTIVE') THEN
    RAISE EXCEPTION 'FALLA: no existe la política restrictiva'; END IF;
  RAISE NOTICE 'OK ETAPA B: Secretaría sin acceso directo a la fila de configuración; owner/admin/médico/atenciones/mensajes sin cambios.';
END $$;

-- ---------- 4C-1 ----------
-- CardioLink · Seguridad clínica V1 · BLOQUE 4C-1 (ajuste v2.6) · SEGURIDAD DOCUMENTAL (cardiolink_patient_documents + Storage patient-documents)
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. Primero STAGING (yslhwdlzdknhskawqrtv); Production sólo con autorización aparte.
-- No está en supabase/migrations a propósito: `supabase db push` no debe poder aplicarla por accidente.
-- SIN EJECUTAR: la sintaxis no se validó contra una base. Antes de aplicar: ensayo reversible (pending_review_documentos_seguridad_4c1_ensayo_reversible.sql).
--
-- REGLAS DE NEGOCIO CONFIRMADAS (dueño).
--   * Secretaría EMITE constancias, certificados y órdenes, por indicación de un profesional autorizado y con SU membrete, sello y firma.
--   * Secretaría SUBE, consulta, gestiona, descarga, imprime y envía: lo anterior + ECG, Holter, MAPA, ecocardiogramas, estudios, informes, laboratorios, recetas, indicaciones,
--     aptos físicos y otros documentos administrativos y médicos. NO modifica el contenido médico firmado.
--   * Imágenes adjuntas a evoluciones ('Imagen clínica', ruta clinical-images/): acceso clínico (owner/admin/médico). Imágenes de estudios independientes: gestión administrativa.
--   * 'Mensaje a colega': reservado a médicos. Notas clínicas privadas: Bloque 4C-2 (no es materia de este SQL).
--
-- HALLAZGOS DE LA AUDITORÍA REAL DE STAGING (53 documentos, 15 tipos) QUE ESTE BLOQUE RESUELVE:
--   (1) el médico consulta documentos de cualquier paciente (sin comprobar asociación);  (2) el médico actualiza documentos ajenos;
--   (3) Storage no está ligado a la fila: el acceso es por ruta;  (4) Secretaría emite/sube a nombre de cualquier profesional (o de ninguno);
--   (5) una fila documental podía apuntar al storage_path de un archivo AJENO (huérfano o restringido) y así "abrirlo" por la regla de Storage;
--   (6) attention_id / evolution_id aceptaban cualquier texto (la FK sólo cubre evolution_id): un documento podía vincularse a la atención/evolución de OTRO paciente o de OTRO profesional.
--   (7) DECISIÓN v2.2: Secretaría sólo consulta, visualiza, descarga, imprime y ENVÍA documentos de profesionales con los que tiene una asociación ACTIVA; los documentos sin profesional identificable no le
--       son visibles; al desactivar la asociación pierde el acceso al instante. Se verifica en el SERVIDOR (tabla, Storage y, por herencia de la RLS, listados, búsquedas, vista previa, descargas, envíos y API directa);
--   (8) una fila "nueva versión" podía reclamar el source_document_id de un documento AJENO (paciente o profesional distintos) y pasar a ser la versión vigente (la más reciente por source_document_id).
--   (9) v2.3: la función SECURITY DEFINER cardiolink_historial_envios_documento_v1 (propuesta pending_review_communications_historial_documental_v1, PARTE 1; ya probada en STAGING) devolvía a Secretaría el historial
--       de TODOS los documentos pedidos: ignoraba la RLS y la regla de asociación activa. Este bloque la REEMPLAZA (mismo nombre, firma y columnas) con validación explícita en la propia función.
--   Ya correcto y NO se toca: Secretaría sin UPDATE ni DELETE; DELETE del médico con titularidad; políticas de imagen clínica ya RESTRICTIVE (se reemplazan por equivalentes más estrictas).
--
-- QUÉ HACE. Todo ADITIVO y RESTRICTIVE (se combina por AND con las permisivas existentes: ninguna permisiva presente o futura puede abrir lo que esto cierra):
--   1) cardiolink_tipos_documento_secretaria_v1(): única lista de tipos de Secretaría (cerrados: 'Imagen clínica', 'Mensaje a colega' y todo tipo no listado).
--   2) Acceso del médico al paciente: se REUTILIZA la función existente cardiolink_paciente_acceso_clinico_v1(text) (confirmada en STAGING: asociación manual activa, evolución propia, atención
--      propia y validación de paciente existente). Este bloque NO duplica esa lógica: sólo la invoca desde las políticas.
--   3) cardiolink_profesionales_autorizados_secretaria_v1() / cardiolink_secretaria_autorizada_prof_v1(prof): profesionales por cuenta de los cuales una Secretaría puede emitir/subir =
--      los de sus asociaciones ACTIVAS (Bloque 3), cualquiera sea el rol del profesional (el Dueño —rol owner— cuenta igual que un médico). La tabla de asociaciones se descubre por sus
--      columnas (secretaria_user_id, medico_user_id, activo); si no es única, el SQL aborta.
--   4) Ayudas SECURITY DEFINER para Storage: cardiolink_objeto_sin_fila_v1(name) ("archivo propio recién subido") y cardiolink_objeto_asignable_v1(path, paciente): una fila nueva sólo puede
--      apuntar a un archivo QUE YA EXISTE, subido por la misma persona hace menos de 1 hora, y cuya ruta pertenece al MISMO paciente de la fila (nunca al archivo de otro).
--   5) Tabla, 3 políticas RESTRICTIVE (reemplazan las 2 de imagen clínica):
--        SELECT : owner/admin; médico = titular del documento (misma regla que DELETE) o con acceso clínico al paciente (sin cambios); Secretaría = tipo de la lista Y ruta fuera de clinical-images/ Y
--                 profesional del documento entre sus ASOCIACIONES ACTIVAS (profesional NULL ⇒ invisible). Storage, listados, búsquedas, vista previa, descargas (URL firmada), envíos (la Edge Function lee con el
--                 JWT del usuario) y el acceso directo por API HEREDAN esta regla: una sola fuente de verdad, evaluada en cada consulta (sin caché: al desactivar la asociación el acceso cae de inmediato).
--        INSERT : owner/admin; médico = con acceso clínico al paciente, a nombre propio (o sin profesional) y con archivo asignable; Secretaría = tipo de la lista, ruta fuera de
--                 clinical-images/, sin vínculo a evolución, con profesional AUTORIZADO obligatorio y con archivo asignable (trazabilidad del profesional y del archivo).
--        UPDATE : owner/admin; médico = titular o asociado al paciente (qué columnas puede tocar lo decide el trigger de abajo). Secretaría: nunca.
--   5a) Historial de envíos: cardiolink_communications (document_delivery/document) ya no muestra a Secretaría filas de documentos que ella no puede ver (política RESTRICTIVE; médicos y owner/admin no cambian;
--      las filas sin document_id —turnos— tampoco).
--   5d) HISTORIAL POR FUNCIÓN (v2.3): cardiolink_historial_envios_documento_v1(text[]) es SECURITY DEFINER (ignora la RLS), así que la autorización va DENTRO de la función. owner/admin: sin cambios (todo lo pedido, incluso
--      filas de documentos ya eliminados). Médico: regla vigente sin cambios (documentos que emitió él). Secretaría: SOLO envíos de documentos que EXISTEN, con professional_id de una asociación ACTIVA con ella, de un tipo de
--      cardiolink_tipos_documento_secretaria_v1(), que no sean 'Imagen clínica' ni estén bajo clinical-images/. Documento inexistente (huérfano), sin profesional, de otro profesional o de tipo cerrado: no sale. Sigue sin
--      devolver message, subject ni provider_message_id. Si la función ya existía (PARTE 1 aplicada) se REEMPLAZA y el rollback restaura el cuerpo anterior; si no existía se CREA y el rollback la elimina (queda marcado en su comentario).
--   5b) NUEVAS VERSIONES (v2.2): un INSERT con un source_document_id que YA existe es una nueva versión de ese documento: debe conservar el paciente y el profesional de la familia (el tipo puede cambiar) y quien
--      la crea debe ser owner/admin, el médico dueño de ese profesional, o la Secretaría con ese profesional autorizado. El servidor fija created_at (la "versión vigente" es la más reciente: no se puede falsear ni
--      anticipar). Un source_document_id nuevo sigue siendo una primera versión.
--   5c) VÍNCULOS (v2.1): al insertar o CAMBIAR attention_id / evolution_id el destino debe EXISTIR y ser del MISMO paciente del documento (cardiolink_vinculo_documental_v1). Para MÉDICOS además debe
--      ser PROPIO (atención con payload.profesionalId = el suyo; evolución con profesional_id = el suyo) y con acceso clínico al paciente (cardiolink_paciente_acceso_clinico_v1). Desvincular (NULL) es libre
--      salvo que el médico no sea titular del documento y el vínculo vigente sea de otro profesional. Owner/admin: existencia y mismo paciente. Secretaría no vincula evolución (INSERT) ni actualiza.
--   6) Trigger BEFORE INSERT/UPDATE. Con sesión: INSERT fija uploaded_by = auth.uid(). UPDATE: (a) para TODOS (incluidos owner/admin y TODAS las filas, también los PDF subidos a mano) son
--      inmutables la identidad del archivo y del autor: patient_id, storage_path, original_filename, mime_type, size_bytes, created_at, uploaded_by y source_document_id/source_content_hash/
--      source_payload (no se "firma" a posteriori una fila sin payload; las versiones nuevas son INSERT de filas nuevas); (b) en documentos emitidos nadie cambia tipo, profesional ni fecha;
--      (c) salvo owner/admin, sólo attention_id, evolution_id, updated_at y —el titular— title, description, document_date. Complementa cardiolink_patient_documents_guard_version (que
--      protege el payload de las versiones archivadas con P0001) sin reemplazarlo. Es SECURITY DEFINER (con search_path fijo) para poder validar vínculos sin dar EXECUTE del validador a los clientes.
--   7) Storage (bucket patient-documents), 2 políticas RESTRICTIVE (reemplazan las 2 de clinical-images). Staging al auditar: 52 objetos, 0 sin owner, 0 sin owner_id, 0 sin fila:
--        SELECT : owner/admin; o existe una FILA del documento visible para ese usuario (hereda la RLS de la tabla: una sola fuente de verdad); o archivo PROPIO recién subido (1 h)
--                 que todavía no tiene fila (el cliente sube el PDF y recién después inserta la fila); Secretaría nunca bajo clinical-images/.
--        INSERT : owner/admin/médico en cualquier ruta; el resto, fuera de clinical-images/ (la subida manual usa "{paciente}/{uuid}.pdf" y los emitidos "documents/{paciente}/{uuid}.pdf").
-- NO modifica: datos, documentos existentes (no elimina nada), políticas permisivas, DELETE, grants de tablas, Edge Functions ni el portal. Rollback exacto: …_4c1_rollback.sql.


-- ===== 0) Precondiciones (si algo difiere de lo esperado, todo se revierte sin cambios) =====
DO $$
DECLARE n int; v_tipo text; v_tabla text;
BEGIN
  IF to_regclass('public.cardiolink_patient_documents') IS NULL THEN RAISE EXCEPTION 'Precondición: falta public.cardiolink_patient_documents'; END IF;
  IF to_regclass('public.cardiolink_hc_evoluciones') IS NULL OR to_regclass('public.cardiolink_atenciones') IS NULL THEN RAISE EXCEPTION 'Precondición: faltan cardiolink_hc_evoluciones / cardiolink_atenciones'; END IF;
  IF to_regprocedure('public.cardiolink_can_delete_clinical_documents()') IS NULL OR to_regprocedure('public.cardiolink_has_clinical_documents_access()') IS NULL THEN
    RAISE EXCEPTION 'Precondición: faltan las funciones de autorización de documentos'; END IF;
  IF to_regprocedure('public.cardiolink_can_delete_clinical_document(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: falta cardiolink_can_delete_clinical_document(text,uuid) (eliminación por titularidad: pending_review_patient_documents_delete_ownership_v1)'; END IF;
  IF to_regprocedure('public.cardiolink_ctx_rol_v1()') IS NULL OR to_regprocedure('public.cardiolink_ctx_prof_v1()') IS NULL THEN
    RAISE EXCEPTION 'Precondición: faltan cardiolink_ctx_rol_v1() / cardiolink_ctx_prof_v1()'; END IF;
  IF to_regprocedure('public.cardiolink_paciente_acceso_clinico_v1(text)') IS NULL THEN
    RAISE EXCEPTION 'Precondición: falta cardiolink_paciente_acceso_clinico_v1(text) (acceso clínico médico-paciente)'; END IF;
  IF (SELECT prorettype FROM pg_proc WHERE oid = 'public.cardiolink_paciente_acceso_clinico_v1(text)'::regprocedure) <> 'boolean'::regtype THEN
    RAISE EXCEPTION 'Precondición: cardiolink_paciente_acceso_clinico_v1(text) debe devolver boolean'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.cardiolink_paciente_acceso_clinico_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Precondición: authenticated debe poder ejecutar cardiolink_paciente_acceso_clinico_v1(text) (la evalúan las políticas)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_patient_documents'::regclass AND NOT tgisinternal AND tgname='cardiolink_patient_documents_guard_version') THEN
    RAISE EXCEPTION 'Precondición: falta el trigger cardiolink_patient_documents_guard_version (inmutabilidad de versiones archivadas)'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE
       (schemaname='public'  AND tablename='cardiolink_patient_documents' AND policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria'))
    OR (schemaname='storage' AND tablename='objects' AND policyname IN ('cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria'));
  IF n <> 4 THEN RAISE EXCEPTION 'Precondición: se esperaban las 4 políticas restrictivas de imagen clínica (hay %); el estado difiere del repo: revisar con …_checks.sql', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_patient_documents' AND policyname='cardiolink_patient_documents_update' AND permissive='PERMISSIVE') THEN
    RAISE EXCEPTION 'Precondición: falta la política permisiva cardiolink_patient_documents_update'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\' AND ((schemaname='public' AND tablename='cardiolink_patient_documents') OR (schemaname='storage' AND tablename='objects')))
     OR to_regprocedure('public.cardiolink_tipos_documento_secretaria_v1()') IS NOT NULL
     OR to_regprocedure('public.cardiolink_profesionales_autorizados_secretaria_v1()') IS NOT NULL OR to_regprocedure('public.cardiolink_secretaria_autorizada_prof_v1(text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_objeto_sin_fila_v1(text)') IS NOT NULL OR to_regprocedure('public.cardiolink_objeto_asignable_v1(text,text)') IS NOT NULL
     OR to_regprocedure('public.cardiolink_vinculo_documental_v1(text,text,text,boolean)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_communications' AND policyname='cardiolink_communications_select_docs_4c1')
     OR to_regprocedure('public.cardiolink_patient_documents_inmutables_4c1()') IS NOT NULL
     OR coalesce(obj_description(to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])'), 'pg_proc'), '') LIKE '%[4C-1:%' THEN
    RAISE EXCEPTION 'Este bloque ya está aplicado (o parcialmente): no se repite'; END IF;
  SELECT data_type INTO v_tipo FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects' AND column_name='owner';
  IF v_tipo IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'Precondición: storage.objects.owner debe ser uuid (es %)', v_tipo; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects' AND column_name='created_at') THEN RAISE EXCEPTION 'Precondición: falta storage.objects.created_at'; END IF;
  SELECT data_type INTO v_tipo FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_patient_documents' AND column_name='uploaded_by';
  IF v_tipo IS DISTINCT FROM 'uuid' THEN RAISE EXCEPTION 'Precondición: cardiolink_patient_documents.uploaded_by debe ser uuid (es %)', v_tipo; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_patient_documents'
     AND column_name IN ('evolution_id','professional_id','source_payload','source_document_id','document_date','attention_id');
  IF n <> 6 THEN RAISE EXCEPTION 'Precondición: faltan columnas de cardiolink_patient_documents (evolution_id, professional_id, source_payload, source_document_id, document_date, attention_id): hay %', n; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_user_roles' AND column_name IN ('user_id','base_role','active','professional_id');
  IF n <> 4 THEN RAISE EXCEPTION 'Precondición: faltan columnas de cardiolink_user_roles'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='patient-documents' AND NOT public) THEN RAISE EXCEPTION 'Precondición: el bucket patient-documents debe existir y ser privado'; END IF;
  IF to_regclass('public.cardiolink_communications') IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cardiolink_communications' AND column_name='document_id')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='cardiolink_communications' AND policyname='cardiolink_communications_select') THEN
    RAISE EXCEPTION 'Precondición: falta cardiolink_communications (con document_id y su política cardiolink_communications_select)'; END IF;
  SELECT count(*) INTO n FROM (SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo')
                                GROUP BY table_name HAVING count(*) = 3) t;
  IF n <> 1 THEN RAISE EXCEPTION 'Precondición: se esperaba UNA tabla de asociaciones secretaria-médico (columnas secretaria_user_id, medico_user_id, activo) y hay %', n; END IF;
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo')
     GROUP BY table_name HAVING count(*) = 3;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=v_tabla AND column_name='activo') <> 'boolean' THEN
    RAISE EXCEPTION 'Precondición: %.activo debe ser boolean', v_tabla; END IF;
END $$;

-- ===== 1) Lista de tipos de Secretaría (un único lugar). IMMUTABLE: la evalúan las políticas con los privilegios de quien consulta, por eso authenticated necesita EXECUTE =====
-- Futuro módulo de copias para facturación: se agregará su tipo acá (CREATE OR REPLACE) cuando exista; hoy no existe y no se anticipa.
CREATE FUNCTION public.cardiolink_tipos_documento_secretaria_v1()
 RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
 SELECT ARRAY['Constancia','Orden','Certificado','Estudio','Informe','Laboratorio','ECG','ECG y riesgo quirúrgico','Holter','MAPA','Ecocardiograma','Ecografía','Radiografía','Receta','Indicaciones','Apto físico','Otro']::text[]
$f$;

-- ===== 2) Acceso médico-paciente: se reutiliza public.cardiolink_paciente_acceso_clinico_v1(text) (existente; no se redefine) =====

-- ===== 3) Profesionales autorizados de una Secretaría (sus asociaciones activas). La tabla de asociaciones se descubre por columnas =====
DO $$
DECLARE v_tabla text;
BEGIN
  SELECT table_name INTO v_tabla FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('secretaria_user_id','medico_user_id','activo')
     GROUP BY table_name HAVING count(*) = 3;
  EXECUTE format($fmt$
    CREATE FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1()
     RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
    AS $body$
     SELECT coalesce(array_agg(DISTINCT m.professional_id), ARRAY[]::text[])
       FROM public.cardiolink_user_roles s
       JOIN public.%I a ON a.secretaria_user_id = s.user_id AND a.activo IS TRUE
       JOIN public.cardiolink_user_roles m ON m.user_id = a.medico_user_id AND m.active IS TRUE AND coalesce(m.professional_id, '') <> ''
      WHERE s.user_id = auth.uid() AND s.active IS TRUE AND s.base_role = 'secretaria'
    $body$
  $fmt$, v_tabla);
END $$;

CREATE FUNCTION public.cardiolink_secretaria_autorizada_prof_v1(p_prof text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT coalesce(p_prof, '') <> '' AND p_prof = ANY (public.cardiolink_profesionales_autorizados_secretaria_v1())
$f$;

-- ===== 4) Archivo sin fila (ignora la RLS a propósito: "no existe NINGUNA fila", no "no veo ninguna") =====
CREATE FUNCTION public.cardiolink_objeto_sin_fila_v1(p_name text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT NOT EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.storage_path = p_name)
$f$;

-- Una fila documental sólo puede apuntar a un archivo que (a) ya existe, (b) lo subió quien inserta la fila, hace menos de 1 hora, y (c) cuya ruta pertenece al MISMO paciente de la fila
-- ("{paciente}/…", "documents/{paciente}/…" o "clinical-images/{paciente}/…"). Ignora la RLS a propósito (SECURITY DEFINER): "existe y es mío" no puede depender de lo que yo vea.
-- Una fila no puede apuntar al archivo de otro (huérfano ajeno o restringido): storage_path es UNIQUE, así que un archivo con fila ya no es reasignable.
CREATE FUNCTION public.cardiolink_objeto_asignable_v1(p_path text, p_patient text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT coalesce(p_path, '') <> '' AND coalesce(p_patient, '') <> ''
    AND (split_part(p_path, '/', 1) = p_patient
         OR (split_part(p_path, '/', 1) IN ('documents', 'clinical-images') AND split_part(p_path, '/', 2) = p_patient))
    AND EXISTS (SELECT 1 FROM storage.objects o
                 WHERE o.bucket_id = 'patient-documents' AND o.name = p_path AND o.owner = auth.uid() AND o.created_at > now() - interval '1 hour')
$f$;

-- Vínculo documental válido: el destino EXISTE y es del MISMO paciente; con p_solo_propios (médicos) además es PROPIO (y con acceso clínico en la evolución). Ignora la RLS a propósito (SECURITY DEFINER):
-- "existe y corresponde" no puede depender de lo que el llamador pueda ver. NO es ejecutable por los clientes: sólo la invoca el trigger de la tabla. Un id vacío o NULL no se valida (no hay vínculo).
CREATE FUNCTION public.cardiolink_vinculo_documental_v1(p_patient text, p_attention text, p_evolution text, p_solo_propios boolean)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
 SELECT coalesce(p_patient, '') <> ''
    AND (coalesce(p_attention, '') = '' OR EXISTS (
           SELECT 1 FROM public.cardiolink_atenciones a
            WHERE a.id = p_attention
              AND coalesce(a.payload ->> 'tipoRegistro', '') NOT IN ('mensaje', 'config')
              AND (a.payload ->> 'pacienteId' = p_patient
                   OR (p_patient LIKE 'legacy\_%' ESCAPE '\'
                       AND 'legacy_' || pg_catalog.regexp_replace(coalesce(a.payload ->> 'dni', ''), '\D', '', 'g') = p_patient))
              AND (NOT p_solo_propios OR a.payload ->> 'profesionalId' = (SELECT public.cardiolink_ctx_prof_v1()))))
    AND (coalesce(p_evolution, '') = '' OR EXISTS (
           SELECT 1 FROM public.cardiolink_hc_evoluciones e
            WHERE e.id = p_evolution AND e.paciente_id = p_patient
              AND (NOT p_solo_propios OR (e.profesional_id = (SELECT public.cardiolink_ctx_prof_v1()) AND public.cardiolink_paciente_acceso_clinico_v1(p_patient)))))
$f$;

REVOKE ALL ON FUNCTION public.cardiolink_vinculo_documental_v1(text, text, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cardiolink_tipos_documento_secretaria_v1()            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1()  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_secretaria_autorizada_prof_v1(text)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_objeto_sin_fila_v1(text)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cardiolink_objeto_asignable_v1(text, text)            FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cardiolink_tipos_documento_secretaria_v1()            TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_profesionales_autorizados_secretaria_v1()  TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_secretaria_autorizada_prof_v1(text)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_objeto_sin_fila_v1(text)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_objeto_asignable_v1(text, text)            TO authenticated;

-- ===== 5) Tabla: políticas RESTRICTIVE =====
DROP POLICY cardiolink_patient_documents_select_no_img_secretaria ON public.cardiolink_patient_documents;
DROP POLICY cardiolink_patient_documents_insert_no_img_secretaria ON public.cardiolink_patient_documents;

CREATE POLICY cardiolink_patient_documents_select_4c1 ON public.cardiolink_patient_documents
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (public.cardiolink_can_delete_clinical_document(professional_id, uploaded_by) OR public.cardiolink_paciente_acceso_clinico_v1(patient_id)))
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'secretaria'
        AND document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1()) AND storage_path NOT LIKE 'clinical-images/%'
        AND professional_id = ANY (((SELECT public.cardiolink_profesionales_autorizados_secretaria_v1()))::text[]))
  );

CREATE POLICY cardiolink_patient_documents_insert_4c1 ON public.cardiolink_patient_documents
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (professional_id IS NULL OR professional_id = (SELECT public.cardiolink_ctx_prof_v1()))
        AND public.cardiolink_paciente_acceso_clinico_v1(patient_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'secretaria'
        AND document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1()) AND storage_path NOT LIKE 'clinical-images/%'
        AND evolution_id IS NULL AND public.cardiolink_secretaria_autorizada_prof_v1(professional_id)
        AND public.cardiolink_objeto_asignable_v1(storage_path, patient_id))
  );

CREATE POLICY cardiolink_patient_documents_update_4c1 ON public.cardiolink_patient_documents
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (public.cardiolink_can_delete_clinical_document(professional_id, uploaded_by) OR public.cardiolink_paciente_acceso_clinico_v1(patient_id)))
  )
  WITH CHECK (
    (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico'
        AND (public.cardiolink_can_delete_clinical_document(professional_id, uploaded_by) OR public.cardiolink_paciente_acceso_clinico_v1(patient_id)))
  );

-- 5a) Historial de envíos: Secretaría no ve filas de documentos que ella no puede ver (la subconsulta se evalúa con la RLS de quien consulta)
CREATE POLICY cardiolink_communications_select_docs_4c1 ON public.cardiolink_communications
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    document_id IS NULL
    OR (SELECT public.cardiolink_ctx_rol_v1()) IS DISTINCT FROM 'secretaria'
    OR EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.id::text = cardiolink_communications.document_id)
  );

-- 5d) Historial de envíos por FUNCIÓN (SECURITY DEFINER: la RLS no interviene, por eso la autorización está escrita en la función). Reemplaza (o crea) cardiolink_historial_envios_documento_v1.
--     Mismo nombre, firma y 12 columnas que la PARTE 1 de pending_review_communications_historial_documental_v1: el cliente (cardiolink-documentos-pdf-v1.js) no cambia.
DO $$ BEGIN
  PERFORM set_config('cardiolink.rpc_historial_existia', CASE WHEN to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])') IS NULL THEN 'no' ELSE 'si' END, true);
END $$;

CREATE OR REPLACE FUNCTION public.cardiolink_historial_envios_documento_v1(p_document_ids text[])
RETURNS TABLE (
  id uuid,
  document_id text,
  paciente_id text,
  created_at timestamptz,
  canal text,
  status text,
  destinatario text,
  recipient_name text,
  recipient_source text,
  error_message text,
  creado_por_mi boolean,
  automatico boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH yo AS (
    SELECT bool_or(ur.base_role IN ('owner', 'admin')) AS administrativo,
           bool_or(ur.base_role = 'secretaria') AS secretaria,
           bool_or(ur.base_role = 'medico') AS medico,
           max(ur.professional_id) FILTER (WHERE ur.base_role = 'medico') AS professional_id
      FROM public.cardiolink_user_roles AS ur
     WHERE ur.user_id = auth.uid()
       AND ur.active
       AND ur.base_role IN ('owner', 'admin', 'secretaria', 'medico')
  ),
  aut AS (
    SELECT public.cardiolink_profesionales_autorizados_secretaria_v1() AS profesionales
  )
  SELECT c.id, c.document_id, c.paciente_id, c.created_at, c.canal, c.status, c.destinatario,
         c.recipient_name, c.recipient_source, c.error_message,
         (c.created_by IS NOT NULL AND c.created_by = auth.uid()) AS creado_por_mi,
         (c.created_by IS NULL) AS automatico
    FROM public.cardiolink_communications AS c
   CROSS JOIN yo
   CROSS JOIN aut
   WHERE c.tipo = 'document_delivery'
     AND p_document_ids IS NOT NULL
     AND cardinality(p_document_ids) BETWEEN 1 AND 500
     AND c.document_id = ANY (p_document_ids)
     AND (
          -- owner / admin: acceso administrativo (sin cambios)
          coalesce(yo.administrativo, false)
       -- médico: regla vigente (documentos que emitió él)
       OR (
            coalesce(yo.medico, false)
        AND EXISTS (
              SELECT 1
                FROM public.cardiolink_patient_documents AS d
               WHERE d.id::text = c.document_id
                 AND (
                      (d.professional_id IS NOT NULL AND yo.professional_id IS NOT NULL AND d.professional_id = yo.professional_id)
                   OR (d.professional_id IS NULL AND d.uploaded_by IS NOT NULL AND d.uploaded_by = auth.uid())
                 )
            )
          )
       -- Secretaría (v2.3): validación EXPLÍCITA en la función (no depende de la RLS: SECURITY DEFINER la ignora). El documento debe existir, tener
       -- profesional identificable con ASOCIACIÓN ACTIVA con esta Secretaría, ser de un tipo permitido, no ser 'Imagen clínica' ni estar bajo clinical-images/
       OR (
            coalesce(yo.secretaria, false)
        AND EXISTS (
              SELECT 1
                FROM public.cardiolink_patient_documents AS d
               WHERE d.id::text = c.document_id
                 AND coalesce(d.professional_id, '') <> ''
                 AND d.professional_id = ANY (aut.profesionales)
                 AND d.document_type = ANY (public.cardiolink_tipos_documento_secretaria_v1())
                 AND d.document_type <> 'Imagen clínica'
                 AND d.storage_path NOT LIKE 'clinical-images/%'
            )
          )
     )
   ORDER BY c.created_at ASC, c.id ASC;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION public.cardiolink_historial_envios_documento_v1(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cardiolink_historial_envios_documento_v1(text[]) TO authenticated;

DO $$ BEGIN
  EXECUTE format('COMMENT ON FUNCTION public.cardiolink_historial_envios_documento_v1(text[]) IS %L',
    'Historial de envíos de documentos (tipo document_delivery) de los ids pedidos, sin message, subject ni provider_message_id. owner/admin: todos los pedidos; médico: sólo los de documentos que emitió él; '
    || 'Secretaría: sólo los de documentos existentes de profesionales con asociación ACTIVA con ella, de tipo permitido y que no sean Imagen clínica (validado dentro de la función; SECURITY DEFINER no usa la RLS). '
    || CASE WHEN current_setting('cardiolink.rpc_historial_existia', true) = 'no' THEN '[4C-1: creada por este bloque]' ELSE '[4C-1: reemplaza la versión de la propuesta PARTE 1]' END);
END $$;

-- ===== 6) Trigger: identidad del archivo y del autor, contenido firmado, vínculos. SECURITY DEFINER con search_path fijo; sin sesión (service_role / SQL Editor) no interviene =====
CREATE FUNCTION public.cardiolink_patient_documents_inmutables_4c1()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $f$
DECLARE v_perm text[]; v_rol text; v_medico boolean; v_titular boolean; v_cambia_att boolean; v_cambia_evo boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  v_rol := (SELECT public.cardiolink_ctx_rol_v1());
  v_medico := v_rol = 'medico';
  IF TG_OP = 'INSERT' THEN
    NEW.uploaded_by := auth.uid();                      -- el autor lo fija el servidor, no el navegador
    NEW.created_at := clock_timestamp();                -- la versión vigente es la más reciente: la fecha de alta la fija el servidor
    -- NUEVA VERSIÓN de un documento existente (mismo source_document_id): conserva paciente y profesional de la familia y la crea quien está autorizado para ese profesional
    IF coalesce(NEW.source_document_id, '') <> '' AND EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.source_document_id = NEW.source_document_id) THEN
      IF EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d
                  WHERE d.source_document_id = NEW.source_document_id
                    AND (d.patient_id IS DISTINCT FROM NEW.patient_id OR d.professional_id IS DISTINCT FROM NEW.professional_id)) THEN
        RAISE EXCEPTION 'Una versión nueva conserva el paciente y el profesional del documento original' USING ERRCODE = '42501';
      END IF;
      IF NOT (v_rol IN ('owner', 'admin')
              OR (v_medico AND NEW.professional_id IS NOT NULL AND NEW.professional_id = (SELECT public.cardiolink_ctx_prof_v1()))
              OR (v_rol = 'secretaria' AND public.cardiolink_secretaria_autorizada_prof_v1(NEW.professional_id))) THEN
        RAISE EXCEPTION 'Sólo el profesional del documento, una Secretaría autorizada para él u owner/admin pueden emitir una versión nueva' USING ERRCODE = '42501';
      END IF;
    END IF;
    IF (coalesce(NEW.attention_id, '') <> '' OR coalesce(NEW.evolution_id, '') <> '')
       AND NOT public.cardiolink_vinculo_documental_v1(NEW.patient_id, NEW.attention_id, NEW.evolution_id, v_medico) THEN
      RAISE EXCEPTION 'La atención o evolución de destino no existe, no es de este paciente o no es propia' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.storage_path IS DISTINCT FROM OLD.storage_path OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
     OR NEW.source_content_hash IS DISTINCT FROM OLD.source_content_hash OR NEW.source_payload IS DISTINCT FROM OLD.source_payload THEN
    RAISE EXCEPTION 'La identidad del documento (paciente, archivo, autor, contenido firmado) no se modifica: se archiva una versión nueva' USING ERRCODE = '42501';
  END IF;
  IF (OLD.source_payload IS NOT NULL OR OLD.source_document_id IS NOT NULL)
     AND (NEW.document_type IS DISTINCT FROM OLD.document_type OR NEW.professional_id IS DISTINCT FROM OLD.professional_id OR NEW.document_date IS DISTINCT FROM OLD.document_date) THEN
    RAISE EXCEPTION 'El tipo, el profesional y la fecha de un documento emitido o firmado no se modifican: se emite una versión nueva' USING ERRCODE = '42501';
  END IF;
  -- vínculos con la atención / evolución: lo NUEVO debe existir y ser del mismo paciente (y, para médicos, propio); desvincular (NULL) es libre
  v_cambia_att := NEW.attention_id IS DISTINCT FROM OLD.attention_id;
  v_cambia_evo := NEW.evolution_id IS DISTINCT FROM OLD.evolution_id;
  IF (v_cambia_att AND coalesce(NEW.attention_id, '') <> '') OR (v_cambia_evo AND coalesce(NEW.evolution_id, '') <> '') THEN
    IF NOT public.cardiolink_vinculo_documental_v1(NEW.patient_id,
         CASE WHEN v_cambia_att THEN NEW.attention_id END, CASE WHEN v_cambia_evo THEN NEW.evolution_id END, v_medico) THEN
      RAISE EXCEPTION 'La atención o evolución de destino no existe, no es de este paciente o no es propia' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_medico AND (v_cambia_att OR v_cambia_evo) AND NOT public.cardiolink_can_delete_clinical_document(OLD.professional_id, OLD.uploaded_by) THEN
    -- el médico que no es titular sólo suelta o reemplaza vínculos PROPIOS
    IF NOT public.cardiolink_vinculo_documental_v1(OLD.patient_id,
         CASE WHEN v_cambia_att THEN OLD.attention_id END, CASE WHEN v_cambia_evo THEN OLD.evolution_id END, true) THEN
      RAISE EXCEPTION 'El vínculo vigente es de otro profesional: sólo su titular o owner/admin pueden modificarlo' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_rol IN ('owner', 'admin') THEN RETURN NEW; END IF;
  v_titular := public.cardiolink_can_delete_clinical_document(OLD.professional_id, OLD.uploaded_by);
  v_perm := ARRAY['attention_id', 'evolution_id', 'updated_at']
         || CASE WHEN v_titular THEN ARRAY['title', 'description', 'document_date'] ELSE ARRAY[]::text[] END;
  IF (to_jsonb(NEW) - v_perm) IS DISTINCT FROM (to_jsonb(OLD) - v_perm) THEN
    RAISE EXCEPTION 'Sólo se pueden modificar el vínculo con la atención/evolución y, el titular, título, descripción y fecha; tipo y profesional los corrige owner/admin' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$f$;
REVOKE ALL ON FUNCTION public.cardiolink_patient_documents_inmutables_4c1() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER cardiolink_patient_documents_inmutables_4c1
  BEFORE INSERT OR UPDATE ON public.cardiolink_patient_documents
  FOR EACH ROW EXECUTE FUNCTION public.cardiolink_patient_documents_inmutables_4c1();

-- ===== 7) Storage (sólo el bucket patient-documents) =====
DROP POLICY cardiolink_clinical_images_storage_select_no_secretaria ON storage.objects;
DROP POLICY cardiolink_clinical_images_storage_insert_no_secretaria ON storage.objects;

CREATE POLICY cardiolink_patient_documents_storage_select_4c1 ON storage.objects
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    bucket_id <> 'patient-documents'
    OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin')
    OR EXISTS (SELECT 1 FROM public.cardiolink_patient_documents d WHERE d.storage_path = objects.name)
    OR (objects.owner = auth.uid()
        AND objects.created_at > now() - interval '1 hour'
        AND public.cardiolink_objeto_sin_fila_v1(objects.name)
        AND ((SELECT public.cardiolink_ctx_rol_v1()) = 'medico' OR objects.name NOT LIKE 'clinical-images/%'))
  );

CREATE POLICY cardiolink_patient_documents_storage_insert_4c1 ON storage.objects
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id <> 'patient-documents'
    OR (SELECT public.cardiolink_ctx_rol_v1()) IN ('owner', 'admin', 'medico')
    OR objects.name NOT LIKE 'clinical-images/%'
  );

-- ===== 8) Postcondiciones =====
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE permissive='RESTRICTIVE' AND policyname IN
        ('cardiolink_patient_documents_select_4c1','cardiolink_patient_documents_insert_4c1','cardiolink_patient_documents_update_4c1',
         'cardiolink_patient_documents_storage_select_4c1','cardiolink_patient_documents_storage_insert_4c1','cardiolink_communications_select_docs_4c1')) <> 6 THEN
    RAISE EXCEPTION 'FALLA: no quedaron las 6 políticas restrictivas nuevas'; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria',
        'cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria')) THEN
    RAISE EXCEPTION 'FALLA: quedaron las políticas de lista negra anteriores'; END IF;
  IF has_function_privilege('anon','public.cardiolink_tipos_documento_secretaria_v1()','EXECUTE') OR has_function_privilege('anon','public.cardiolink_objeto_asignable_v1(text,text)','EXECUTE')
     OR has_function_privilege('anon','public.cardiolink_profesionales_autorizados_secretaria_v1()','EXECUTE') OR has_function_privilege('anon','public.cardiolink_secretaria_autorizada_prof_v1(text)','EXECUTE')
     OR has_function_privilege('anon','public.cardiolink_objeto_sin_fila_v1(text)','EXECUTE') OR has_function_privilege('authenticated','public.cardiolink_patient_documents_inmutables_4c1()','EXECUTE')
     OR has_function_privilege('anon','public.cardiolink_vinculo_documental_v1(text,text,text,boolean)','EXECUTE') OR has_function_privilege('authenticated','public.cardiolink_vinculo_documental_v1(text,text,text,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'FALLA: privilegios de ejecución inesperados'; END IF;
  IF NOT has_function_privilege('authenticated','public.cardiolink_tipos_documento_secretaria_v1()','EXECUTE') OR NOT has_function_privilege('authenticated','public.cardiolink_objeto_asignable_v1(text,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.cardiolink_secretaria_autorizada_prof_v1(text)','EXECUTE') OR NOT has_function_privilege('authenticated','public.cardiolink_objeto_sin_fila_v1(text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.cardiolink_paciente_acceso_clinico_v1(text)','EXECUTE') THEN
    RAISE EXCEPTION 'FALLA: authenticated no puede ejecutar las funciones que evalúan las políticas'; END IF;
  IF 'Imagen clínica' = ANY (public.cardiolink_tipos_documento_secretaria_v1()) OR 'Mensaje a colega' = ANY (public.cardiolink_tipos_documento_secretaria_v1()) THEN
    RAISE EXCEPTION 'FALLA: tipos cerrados presentes en la lista de Secretaría'; END IF;
  IF public.cardiolink_paciente_acceso_clinico_v1('qa4c_sin_sesion') IS TRUE OR public.cardiolink_secretaria_autorizada_prof_v1(NULL) IS NOT FALSE
     OR public.cardiolink_objeto_asignable_v1('qa4c_sin_sesion/x.pdf', 'qa4c_sin_sesion') IS NOT FALSE THEN
    RAISE EXCEPTION 'FALLA: sin sesión las funciones de acceso deben dar false'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.cardiolink_patient_documents'::regclass AND tgname='cardiolink_patient_documents_inmutables_4c1' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FALLA: no quedó el trigger de inmutables'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.cardiolink_historial_envios_documento_v1(text[])'::regprocedure AND prosecdef
                   AND prosrc LIKE '%cardiolink_profesionales_autorizados_secretaria_v1%' AND prosrc LIKE '%cardiolink_tipos_documento_secretaria_v1%' AND prosrc LIKE '%clinical-images/%')
     OR has_function_privilege('anon','public.cardiolink_historial_envios_documento_v1(text[])','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.cardiolink_historial_envios_documento_v1(text[])','EXECUTE')
     OR coalesce(obj_description('public.cardiolink_historial_envios_documento_v1(text[])'::regprocedure, 'pg_proc'), '') NOT LIKE '%[4C-1:%'
     OR pg_get_function_result('public.cardiolink_historial_envios_documento_v1(text[])'::regprocedure) ~* '\y(message|subject|provider_message_id)\y' THEN
    RAISE EXCEPTION 'FALLA: la función del historial de envíos no quedó con la autorización de Secretaría por asociación activa'; END IF;
END $$;

-- ---------- 4C-1b ----------
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


DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_policies WHERE policyname LIKE '%\_4c1' ESCAPE '\' AND permissive = 'RESTRICTIVE'; IF n <> 6 THEN RAISE EXCEPTION 'FALLA P1: políticas 4C-1 restrictivas = % (esperadas 6)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('cardiolink_tipos_documento_secretaria_v1','cardiolink_profesionales_autorizados_secretaria_v1','cardiolink_secretaria_autorizada_prof_v1','cardiolink_objeto_sin_fila_v1','cardiolink_objeto_asignable_v1','cardiolink_vinculo_documental_v1','cardiolink_patient_documents_inmutables_4c1'); IF n <> 7 THEN RAISE EXCEPTION 'FALLA P2: funciones 4C-1 = % (esperadas 7)', n; END IF;
  IF coalesce(obj_description(to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])'), 'pg_proc'), '') NOT LIKE '%[4C-1:%' THEN RAISE EXCEPTION 'FALLA P3: la RPC del historial no quedó con la marca de 4C-1'; END IF;
  IF public.cardiolink_config_tipos_doc_sec_v1() IS DISTINCT FROM ARRAY['constancia_atencion','certificado','reposo_laboral','orden']::text[] THEN RAISE EXCEPTION 'FALLA P4: lista de heredados de 4C-1b'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_v1' ESCAPE '\') <> 0
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('cardiolink_hc_evoluciones','cardiolink_hc_resumen') AND policyname LIKE '%\_authenticated' ESCAPE '\') <> 2 THEN RAISE EXCEPTION 'FALLA P5: p3 está postergado: las políticas de HC deben quedar como están (2 abiertas, 0 _v1)'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE policyname IN ('cardiolink_patient_documents_select_no_img_secretaria','cardiolink_patient_documents_insert_no_img_secretaria','cardiolink_clinical_images_storage_select_no_secretaria','cardiolink_clinical_images_storage_insert_no_secretaria')) <> 0 THEN RAISE EXCEPTION 'FALLA P6: quedaron políticas anteriores de imagen clínica'; END IF;
  RAISE EXCEPTION 'ENSAYO_PRODUCTION_OK: p1, p2, 4B-A, 4B-B, 4C-1 y 4C-1b (sin p3) se aplican en orden sobre el catálogo real y los checks pasan; las políticas de HC no cambian; se revierte TODO (nada persistido).';
END $$;
ROLLBACK;
