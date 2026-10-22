-- CardioLink · Historial de envíos de documentos · PARTE 2: cerrar la lectura directa de cardiolink_communications para médicos
-- BORRADOR PARA REVISIÓN. NO EJECUTAR sin autorización explícita. Primero STAGING; Production sólo con autorización aparte.
-- APLICAR SÓLO DESPUÉS de la PARTE 1 y de publicar/probar el cliente que usa la función (si no, el historial queda vacío para el médico).
--
-- Por qué hace falta: la función de la PARTE 1 no cierra la exposición por sí sola; mientras la policy SELECT de la tabla siga dejando
-- leer a los médicos, cualquiera con su sesión puede pedir la tabla completa por PostgREST (message, subject, destinatarios de todos los pacientes).
--
-- Qué hace (y nada más):
--   1) crea cardiolink_has_communications_read_access(): owner / admin / secretaria activos (acceso operativo de Secretaría intacto);
--   2) cambia la policy SELECT de cardiolink_communications para usar esa función (el médico deja de poder leer la tabla directa; sí lee su
--      historial documental por la función de la PARTE 1).
-- NO modifica: cardiolink_has_communications_access() (los envíos siguen autorizando a médicos), datos, grants de tabla (sigue sólo SELECT para
-- authenticated; INSERT/UPDATE/DELETE siguen sin existir), Edge Functions (leen y escriben con service_role, que ignora RLS) ni el historial existente.
-- Verificado en el repo: ningún módulo del cliente lee cardiolink_communications directo salvo el historial documental (que pasa a la función).
-- Rollback: pending_review_communications_historial_documental_v1_rollback.sql (sección A).

begin;

do $$
begin
  if to_regprocedure('public.cardiolink_has_communications_access()') is null then
    raise exception 'falta cardiolink_has_communications_access()';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='cardiolink_communications' and policyname='cardiolink_communications_select') then
    raise exception 'falta la policy cardiolink_communications_select';
  end if;
  if to_regprocedure('public.cardiolink_historial_envios_documento_v1(text[])') is null then
    raise exception 'aplicar primero la PARTE 1 (cardiolink_historial_envios_documento_v1)';
  end if;
end $$;

create or replace function public.cardiolink_has_communications_read_access()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.cardiolink_user_roles as ur
     where ur.user_id = auth.uid()
       and ur.active
       and ur.base_role in ('owner', 'admin', 'secretaria')
  );
$function$;

revoke all privileges on function public.cardiolink_has_communications_read_access() from public, anon, authenticated;
grant execute on function public.cardiolink_has_communications_read_access() to authenticated;

drop policy cardiolink_communications_select on public.cardiolink_communications;
create policy cardiolink_communications_select
on public.cardiolink_communications
for select to authenticated
using (public.cardiolink_has_communications_read_access());

commit;
