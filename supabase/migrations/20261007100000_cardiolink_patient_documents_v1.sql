-- CardioLink Admin - Documentos y estudios PDF en la ficha del paciente (V1)
--
-- Fase 6 - Bloque 6D. Agrega la infraestructura para subir PDFs reales
-- (estudios/informes/laboratorio/etc) asociados a un paciente: Storage
-- privado + tabla de metadata separada del archivo. No reemplaza ni toca
-- data.documentosClinicos (documentos de texto generados por CardioLink:
-- receta/orden/certificado/constancia) ni las tablas de HC relacional
-- (cardiolink_hc_evoluciones / cardiolink_hc_resumen). Feature
-- independiente, sin mezclar con ninguna de las dos.
--
-- Alcance de esta migracion: SOLO la tabla cardiolink_patient_documents,
-- su funcion de autorizacion, sus policies, el bucket de Storage
-- patient-documents y las policies de storage.objects para ese bucket.
-- No modifica ninguna tabla/funcion/policy existente.
--
-- SOLO SE APLICA A STAGING (yslhwdlzdknhskawqrtv) en este momento. NO
-- ejecutar contra Production hasta una instruccion explicita separada.

begin;

-- ---------------------------------------------------------------------------
-- 1) Tabla de metadata. El archivo en si vive unicamente en Storage
--    (bucket patient-documents, path storage_path); esta tabla nunca
--    guarda el PDF ni base64 ni ningun contenido binario.
--
--    patient_id es texto libre (igual que el resto de los vinculos a
--    paciente en este repo: cardiolink_communications, documentosClinicos,
--    etc) y DELIBERADAMENTE sin foreign key a cardiolink_pacientes(id):
--    existen pacientes identificados solo por clave local/legacy
--    ("legacy_" + dni, ver patientKey406 en app.js) todavia sin fila
--    propia en cardiolink_pacientes; una FK NOT NULL rompiria la carga de
--    documentos para esos casos. Mismo criterio ya aplicado en
--    cardiolink_communications.
-- ---------------------------------------------------------------------------

create table public.cardiolink_patient_documents (
  id uuid primary key default gen_random_uuid(),
  patient_id text not null,
  attention_id text null,
  document_date date not null default current_date,
  document_type text not null,
  title text not null,
  description text null,
  professional_id text null,
  storage_path text not null unique,
  original_filename text not null,
  mime_type text not null,
  size_bytes bigint null,
  uploaded_by uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.cardiolink_patient_documents is
  'Fase 6 / Bloque 6D. Metadata de PDFs reales (estudios/informes/etc) '
  'subidos a la ficha del paciente. El archivo vive en el bucket privado '
  'de Storage patient-documents, en storage_path. document_type es un '
  'catalogo simple en codigo (app.js), no una tabla - ver nota en el '
  'informe de 6D.';

create index idx_cardiolink_patient_documents_patient
  on public.cardiolink_patient_documents (patient_id);

create index idx_cardiolink_patient_documents_date
  on public.cardiolink_patient_documents (document_date);

-- ---------------------------------------------------------------------------
-- 2) Autorizacion - auditoria previa (Bloque 6D, punto 5 de seguridad):
--
--    Se revisaron las 3 funciones cardiolink_has_*_access() existentes
--    (appointment_requests, finance, communications) y la tabla
--    cardiolink_user_roles que todas comparten. Ninguna es especifica de
--    "trabajar con pacientes e historia clinica". La unica senal real y
--    ya existente para esa pregunta exacta es la funcion de CLIENTE
--    puedeAccederInformacionClinica() (app.js), que hoy determina en la
--    UI quien puede ver/emitir documentos clinicos del paciente:
--      puedeAccederInformacionClinica() = esMatiasDuenio() ||
--        esAdminComun() || esMedico()
--    es decir base_role IN ('owner','admin','medico') - secretaria queda
--    afuera, igual que en esa funcion de cliente.
--
--    cardiolink_has_clinical_documents_access() es la version SQL/RLS de
--    esa misma regla, con el mismo patron SECURITY DEFINER ya usado por
--    las 3 funciones anteriores (lee cardiolink_user_roles via auth.uid(),
--    nunca un rol que mande el cliente). No es un segundo sistema de
--    roles: reutiliza la misma tabla cardiolink_user_roles y el mismo
--    base_role de siempre: solo expone en SQL una regla que hoy ya existe
--    en el cliente para esta misma pregunta.
--
--    Subir / ver / descargar / eliminar usan TODOS la misma funcion: el
--    modelo actual no distingue con seguridad un permiso de "eliminar"
--    mas estricto que "acceder a informacion clinica" dentro de
--    owner/admin/medico (los 3 ya son, por definicion de la app, quienes
--    pueden gestionar la HC del paciente). Por instruccion explicita de
--    la tarea ("si el modelo actual no permite distinguirlo de forma
--    segura: no inventar, usar el permiso existente mas cercano y
--    documentarlo"), no se crea una segunda funcion ni un rol nuevo solo
--    para eliminar.
-- ---------------------------------------------------------------------------

create function public.cardiolink_has_clinical_documents_access()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.cardiolink_user_roles as user_role
     where user_role.user_id = auth.uid()
       and user_role.active
       and user_role.base_role in ('owner', 'admin', 'medico')
  );
$function$;

revoke all privileges on function public.cardiolink_has_clinical_documents_access()
  from public, anon, authenticated;
grant execute on function public.cardiolink_has_clinical_documents_access() to authenticated;

-- ---------------------------------------------------------------------------
-- 3) RLS de la tabla de metadata. anon sin ningun privilegio. authenticated
--    solo select/insert/delete (no hay UI de edicion de metadata en V1,
--    asi que no se otorga update).
-- ---------------------------------------------------------------------------

alter table public.cardiolink_patient_documents enable row level security;

revoke all privileges on table public.cardiolink_patient_documents
  from public, anon, authenticated;

grant select, insert, delete on table public.cardiolink_patient_documents
  to authenticated;

create policy cardiolink_patient_documents_select
on public.cardiolink_patient_documents
for select to authenticated
using (public.cardiolink_has_clinical_documents_access());

create policy cardiolink_patient_documents_insert
on public.cardiolink_patient_documents
for insert to authenticated
with check (public.cardiolink_has_clinical_documents_access());

create policy cardiolink_patient_documents_delete
on public.cardiolink_patient_documents
for delete to authenticated
using (public.cardiolink_has_clinical_documents_access());

-- ---------------------------------------------------------------------------
-- 4) Bucket de Storage privado. NUNCA public=true: ver/descargar se hacen
--    siempre con URL firmada temporal desde el cliente (nunca una URL
--    publica permanente).
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'patient-documents',
  'patient-documents',
  false,
  20971520, -- 20 MB
  array['application/pdf']
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 5) RLS de storage.objects, acotada a este bucket unicamente (no toca
--    objetos de ningun otro bucket). Mismo criterio de permisos que la
--    tabla de metadata (punto 2). Sin policy de update: el flujo de V1 no
--    reemplaza un archivo en el mismo path, solo sube/borra.
-- ---------------------------------------------------------------------------

create policy cardiolink_patient_documents_storage_select
on storage.objects
for select to authenticated
using (
  bucket_id = 'patient-documents'
  and public.cardiolink_has_clinical_documents_access()
);

create policy cardiolink_patient_documents_storage_insert
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'patient-documents'
  and public.cardiolink_has_clinical_documents_access()
);

create policy cardiolink_patient_documents_storage_delete
on storage.objects
for delete to authenticated
using (
  bucket_id = 'patient-documents'
  and public.cardiolink_has_clinical_documents_access()
);

commit;
