-- CardioLink · Seguridad clínica V1 · PARTE 1 · Asociaciones Secretaría–Médico (Bloque 3)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md

BEGIN;
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

COMMIT;
