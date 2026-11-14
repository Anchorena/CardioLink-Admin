-- CardioLink · Seguridad clínica V1 · PARTE 2 · Acceso clínico médico–paciente (Bloque 4: vínculo manual + predicado)
-- Recuperado de STAGING (catálogo: pg_get_functiondef / pg_get_constraintdef / pg_policies / aclexplode, 2026-11-13); QA de STAGING aprobado. Versionado para publicar en Production.
-- NO EJECUTAR en Production sin autorización explícita. Una sola transacción, sin DML sobre datos. Falla (y revierte todo) si el estado no es el esperado.
-- Orden de publicación y rollback: docs/propuestas/pending_review_seguridad_clinica_v1_PUBLICACION.md

BEGIN;
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

COMMIT;
