-- CardioLink · Historial de envíos de documentos · ROLLBACK
-- Ejecutar SÓLO la sección que corresponda, en el mismo entorno donde se aplicó. Cada sección es idempotente y no toca datos.
--   A) deshace la PARTE 2 (vuelve la policy SELECT original: owner/admin/secretaria/médico leen la tabla).
--   B) deshace la PARTE 1 (borra la función del historial). Si el cliente nuevo ya está publicado, el historial dejará de cargar (muestra "no disponible").
-- Orden si se revierte todo: A y luego B.

-- ===== A) PARTE 2 =====
begin;
drop policy if exists cardiolink_communications_select on public.cardiolink_communications;
create policy cardiolink_communications_select
on public.cardiolink_communications
for select to authenticated
using (public.cardiolink_has_communications_access());
drop function if exists public.cardiolink_has_communications_read_access();
commit;

-- ===== B) PARTE 1 =====
begin;
drop function if exists public.cardiolink_historial_envios_documento_v1(text[]);
commit;
