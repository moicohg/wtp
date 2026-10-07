-- Conexión por QR (Evolution API): el panel crea la instancia, muestra el QR y
-- necesita saber si el teléfono ya lo escaneó. Antes un canal Evolution contaba
-- como "Conectado" con solo tener evolution_instance_id, aunque nadie hubiera
-- escaneado nada. evolution_connected lo escriben las Edge Functions
-- (evolution-connect y el evento connection.update de whatsapp-handler), nunca
-- el cliente: por eso solo se da grant de select.

alter table public.vendors
  add column if not exists evolution_connected boolean not null default false;

-- Los canales Evolution ya existentes se asumen conectados (así se mostraban hasta hoy).
update public.vendors set evolution_connected = true
  where channel_type = 'evolution' and evolution_instance_id is not null;

grant select (evolution_connected) on public.vendors to authenticated;
