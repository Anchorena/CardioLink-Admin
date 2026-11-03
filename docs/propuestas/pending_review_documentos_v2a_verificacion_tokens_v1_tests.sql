-- CardioLink · Documentos V2A / F3 — QA TRANSACCIONAL del control de uso único de tokens (ejecutar DESPUÉS de aplicar ..._tokens_v1.sql en STAGING).
-- NO EJECUTAR sin autorización explícita. Una sola transacción implícita que SIEMPRE se revierte: termina en un error intencional con el informe
-- ('RESULTADO TOKENS V2A: aprobadas=N, fallidas=M, total=T' + lista de fallas). Sin BEGIN/COMMIT explícitos a propósito.
-- La concurrencia real (dos pedidos simultáneos con el mismo token) se prueba aparte, contra la función pública (ver docs/propuestas/documentos-v2a-f3-verificacion-publica.md).

create temp table _res (n serial, prueba text, ok boolean, detalle text) on commit drop;
grant all on _res to public; grant usage on sequence _res_n_seq to public;

create function pg_temp.como(p_rol text, p_sql text) returns text language plpgsql as $f$
declare v text;
begin
  execute 'set local role ' || quote_ident(p_rol);
  begin execute p_sql into v; execute 'reset role'; return 'OK' || coalesce(': ' || v, '');
  exception when others then execute 'reset role'; return 'ERR: ' || sqlerrm; end;
end $f$;
create function pg_temp.anota(p_prueba text, p_ok boolean, p_detalle text default null) returns void language sql as
$f$ insert into _res (prueba, ok, detalle) values (p_prueba, coalesce(p_ok, false), p_detalle) $f$;

do $$
declare r text; i int; fallo boolean; antes int; despues int;
  h1 text := encode(sha256('token-sintetico-1'::bytea), 'hex');
  h2 text := encode(sha256('token-sintetico-2'::bytea), 'hex');
begin
  -- 1) uso único
  perform pg_temp.anota('1a. el primer uso del token es válido', public.cardiolink_verificacion_token_usar_v1(h1), null);
  perform pg_temp.anota('1b. el segundo uso del MISMO token se rechaza', not public.cardiolink_verificacion_token_usar_v1(h1), null);
  perform pg_temp.anota('1c. el tercer uso del mismo token también se rechaza', not public.cardiolink_verificacion_token_usar_v1(h1, 120), null);
  perform pg_temp.anota('1d. un token distinto sí pasa (no hay bloqueo cruzado)', public.cardiolink_verificacion_token_usar_v1(h2), null);
  perform pg_temp.anota('1e. cada token deja exactamente una fila', (select count(*) from public.cardiolink_verificacion_tokens_usados where token_hash in (h1, h2)) = 2, null);
  -- 2) vencimiento: un hash vencido NO vuelve a ser válido (aunque la limpieza no haya corrido)
  update public.cardiolink_verificacion_tokens_usados set creado_en = now() - interval '20 minutes', expira_en = now() - interval '10 minutes' where token_hash = h1;
  perform pg_temp.anota('2a. un hash vencido y aún no limpiado sigue rechazándose', not public.cardiolink_verificacion_token_usar_v1(h1), null);
  perform pg_temp.anota('2b. el vencimiento por defecto es de 600 s', (select expira_en - creado_en from public.cardiolink_verificacion_tokens_usados where token_hash = h2) = interval '600 seconds', null);
  -- 3) parámetros inválidos
  for i in 1..9 loop
    fallo := false;
    begin
      perform case i
        when 1 then public.cardiolink_verificacion_token_usar_v1(null)
        when 2 then public.cardiolink_verificacion_token_usar_v1('')
        when 3 then public.cardiolink_verificacion_token_usar_v1('abc')
        when 4 then public.cardiolink_verificacion_token_usar_v1(upper(h1))
        when 5 then public.cardiolink_verificacion_token_usar_v1(h1 || 'aa')
        when 6 then public.cardiolink_verificacion_token_usar_v1(h1 || ';drop table x')
        when 7 then public.cardiolink_verificacion_token_usar_v1(encode(sha256('x'::bytea), 'hex'), 59)
        when 8 then public.cardiolink_verificacion_token_usar_v1(encode(sha256('y'::bytea), 'hex'), 3601)
        else public.cardiolink_verificacion_token_usar_v1(encode(sha256('z'::bytea), 'hex'), null) end;
    exception when others then fallo := true; end;
    perform pg_temp.anota('3.' || i || ' parámetro inválido rechazado', fallo, null);
  end loop;
  -- 4) privilegios
  r := pg_temp.como('anon', $q$select public.cardiolink_verificacion_token_usar_v1(repeat('a', 64))::text$q$);
  perform pg_temp.anota('4a. anon NO puede ejecutar la función', r like 'ERR:%', r);
  r := pg_temp.como('authenticated', $q$select public.cardiolink_verificacion_token_usar_v1(repeat('a', 64))::text$q$);
  perform pg_temp.anota('4b. authenticated NO puede ejecutar la función', r like 'ERR:%', r);
  r := pg_temp.como('service_role', $q$select public.cardiolink_verificacion_token_usar_v1(repeat('b', 64))::text$q$);
  perform pg_temp.anota('4c. service_role SÍ puede ejecutarla', r = 'OK: true', r);
  r := pg_temp.como('service_role', $q$select public.cardiolink_verificacion_token_usar_v1(repeat('b', 64))::text$q$);
  perform pg_temp.anota('4d. y como service_role el reuso también se rechaza', r = 'OK: false', r);
  r := pg_temp.como('authenticated', 'select count(*)::text from public.cardiolink_verificacion_tokens_usados');
  perform pg_temp.anota('4e. el cliente no lee la tabla', r like 'ERR:%' and pg_temp.como('anon', 'select count(*)::text from public.cardiolink_verificacion_tokens_usados') like 'ERR:%', r);
  r := pg_temp.como('authenticated', $q$insert into public.cardiolink_verificacion_tokens_usados (token_hash, expira_en) values (repeat('c', 64), now() + interval '1 hour')$q$);
  perform pg_temp.anota('4f. el cliente no puede insertar tokens', r like 'ERR:%', r);
  perform pg_temp.anota('4g. SECURITY DEFINER con search_path fijo', (select prosecdef and array_to_string(proconfig, ',') like '%search_path=pg_catalog, public%' from pg_proc where proname = 'cardiolink_verificacion_token_usar_v1'), null);
  -- 5) la tabla no crece sin límite: limpieza acotada (probabilística; 700 llamadas => prob. de no limpiar < 1e-15)
  insert into public.cardiolink_verificacion_tokens_usados (token_hash, creado_en, expira_en) select encode(sha256(('viejo' || g)::bytea), 'hex'), now() - interval '2 hours', now() - interval '1 hour' from generate_series(1, 200) g;
  select count(*) into antes from public.cardiolink_verificacion_tokens_usados where expira_en < now() - interval '30 minutes';
  for i in 1..700 loop perform public.cardiolink_verificacion_token_usar_v1(encode(sha256(('carga' || i)::bytea), 'hex')); end loop;
  select count(*) into despues from public.cardiolink_verificacion_tokens_usados where expira_en < now() - interval '30 minutes';
  perform pg_temp.anota('5a. los vencidos se purgan de forma acotada', despues < antes, 'antes=' || antes || ' despues=' || despues);
  perform pg_temp.anota('5b. los tokens vigentes no se purgan', (select count(*) from public.cardiolink_verificacion_tokens_usados where token_hash = h2) = 1
                        and (select count(*) from public.cardiolink_verificacion_tokens_usados where expira_en > now()) >= 700, null);
  perform pg_temp.anota('5c. un token cuya fila se purgó (vencido) no es validable por Cloudflare; aquí sólo se comprueba que la función no falla', public.cardiolink_verificacion_token_usar_v1(encode(sha256('viejo1'::bytea), 'hex')) is not null, null);
  -- 6) lo que se guarda
  perform pg_temp.anota('6. sólo hash y fechas (sin token, IP ni datos clínicos)', (select count(*) from information_schema.columns where table_name = 'cardiolink_verificacion_tokens_usados') = 3, null);
end $$;

do $$
declare v_f text; v_ap int; v_fa int; v_to int;
begin
  select count(*) filter (where ok), count(*) filter (where not ok), count(*) into v_ap, v_fa, v_to from _res;
  select string_agg(n || ' ' || prueba || ' => ' || coalesce(left(detalle, 200), ''), E'\n' order by n) into v_f from _res where not ok;
  raise exception E'RESULTADO TOKENS V2A (esta transacción se revierte): aprobadas=%, fallidas=%, total=%\n%', v_ap, v_fa, v_to, coalesce(v_f, 'sin fallas');
end $$;
