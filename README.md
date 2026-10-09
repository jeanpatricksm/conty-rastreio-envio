# Rastreio do produto enviado ao criador

API que cadastra o código de rastreio num agregador (o fictício **RastreiaJá**), consulta e recebe eventos, traduz o dialeto de cada transportadora para cinco status estáveis e avisa quando o tempo em trânsito passa do limite.

## Como rodar

Node 22 ou mais novo.

```bash
npm install
npm test
npm run dev   # http://127.0.0.1:3007, com o RastreiaJá simulado em memória
# RASTREIAJA_URL=… RASTREIAJA_API_KEY=… npm run dev   para um agregador de verdade
# TRANSIT_LIMIT_HOURS=168                              limite padrão (7 dias)
```

```bash
curl -s -X POST localhost:3007/shipments -H 'content-type: application/json' \
  -d '{"tracking_code":"QB123456789BR","carrier":"correios","campaign_id":"cmp_1","creator_id":"crt_1","transit_limit_hours":72}'
curl -s -X POST localhost:3007/shipments/shp_…/refresh     # consulta o agregador
curl -s localhost:3007/shipments/shp_…                     # status, histórico, atraso, avisos
curl -s -X POST localhost:3007/jobs/check-delays           # job periódico de atraso
curl -s -X POST localhost:3007/webhooks/aggregator -H 'content-type: application/json' \
  -d '{"event":"tracking.updated","data":{…payload do RastreiaJá…}}'
```

## Status normalizado

`posted`, `in_transit`, `out_for_delivery`, `delivered` e `exception`. Antes do primeiro evento da transportadora, o status é `null`.

### Exemplo: payload bruto → normalizado

Payload do RastreiaJá ([`examples/rastreiaja-tracking.json`](examples/rastreiaja-tracking.json)). Ele vem fora de ordem, com um evento repetido (`ck_2`) e um código que a transportadora inventou (`XPTO-99`):

```json
{
  "tracking_number": "QB123456789BR",
  "carrier_slug": "correios",
  "checkpoints": [
    { "id": "ck_3", "checkpoint_time": "2026-05-06T09:05:00-03:00", "status_code": "OEC", "message": "Objeto saiu para entrega ao destinatário", "city": "Rio de Janeiro", "state": "RJ" },
    { "id": "ck_1", "checkpoint_time": "2026-05-04T10:12:00-03:00", "status_code": "PO", "message": "Objeto postado", "city": "São Paulo", "state": "SP" },
    { "id": "ck_4", "checkpoint_time": "2026-05-06T09:30:00-03:00", "status_code": "XPTO-99", "message": "Objeto em análise", "city": "Rio de Janeiro", "state": "RJ" },
    { "id": "ck_2", "checkpoint_time": "2026-05-05T08:40:00-03:00", "status_code": "RO", "message": "Objeto em trânsito - por favor aguarde", "city": "Cajamar", "state": "SP" },
    { "id": "ck_2", "checkpoint_time": "2026-05-05T08:40:00-03:00", "status_code": "RO", "message": "Objeto em trânsito - por favor aguarde", "city": "Cajamar", "state": "SP" }
  ]
}
```

Resultado em `GET /shipments/:id` (trecho):

```json
{
  "tracking_code": "QB123456789BR",
  "status": "out_for_delivery",
  "status_since": "2026-05-06T12:05:00.000Z",
  "events": [
    { "event_key": "rj:ck_1", "raw_status": "PO",      "status": "posted",           "occurred_at": "2026-05-04T13:12:00.000Z", "location": "São Paulo/SP" },
    { "event_key": "rj:ck_2", "raw_status": "RO",      "status": "in_transit",       "occurred_at": "2026-05-05T11:40:00.000Z", "location": "Cajamar/SP" },
    { "event_key": "rj:ck_3", "raw_status": "OEC",     "status": "out_for_delivery", "occurred_at": "2026-05-06T12:05:00.000Z", "location": "Rio de Janeiro/RJ" },
    { "event_key": "rj:ck_4", "raw_status": "XPTO-99", "status": "unknown",          "occurred_at": "2026-05-06T12:30:00.000Z", "location": "Rio de Janeiro/RJ" }
  ],
  "delay": { "state": "on_time", "transit_started_at": "2026-05-04T13:12:00.000Z", "limit_hours": 72, "transit_hours": 47 }
}
```

O `ck_2` repetido virou um evento só. O `XPTO-99` ficou no histórico como `unknown` e não mudou o status, mesmo sendo o evento mais recente.

### Regras

- **A tradução fica num lugar só** ([`src/status.ts`](src/status.ts)): uma tabela por transportadora (Correios, Jadlog, Loggi).
- **Status desconhecido nunca vira entregue.** Código fora da tabela, ou de uma transportadora que não conhecemos, vira `unknown`: fica no histórico com o código cru e não altera o status. Não há palpite pelo texto da mensagem.
- **O status sai do histórico inteiro, não da ordem de chegada.** Vale o evento conhecido de maior `occurred_at`, e `delivered` é terminal. Um evento antigo que chega depois entra no histórico, mas não faz o status voltar. Em empate de instante, vence o maior avanço, e `exception` vence `out_for_delivery`.
- **Consultar de novo não duplica:** cada evento tem uma chave, o id do agregador ou, sem id, um hash do conteúdo. `(envio, chave)` é único.
- O webhook e a consulta passam pelo mesmo caminho e têm a mesma deduplicação.

## Atraso

Regra em [`src/delay.ts`](src/delay.ts):

- **O relógio começa no primeiro evento da transportadora** (postagem ou movimento), pelo `occurred_at`, mesmo que esse evento chegue por último. Pacote ainda não postado não conta como atraso de trânsito.
- **O relógio para na entrega**, pelo `occurred_at` do evento de entrega. Assim, **uma entrega normal descoberta tarde não é atraso**: se o pacote foi entregue em 54h e só consultamos no 6º dia, o estado é `delivered_on_time`.
- **Atraso é passar do limite.** O limite é configurável por envio (`transit_limit_hours`) e tem um padrão global (`TRANSIT_LIMIT_HOURS`, 7 dias). Exatamente no limite ainda está no prazo.
- **O aviso sai uma vez por envio**, com a chave única `(envio, transit_delayed)` em `alerts`. O `Notifier` é injetável (hoje grava um log; em produção seria e-mail ou Slack).
- O job `POST /jobs/check-delays` consulta o agregador antes de avaliar, porque uma entrega recém-registrada evita um falso aviso. Se o agregador estiver fora, ele avalia com o histórico que já tem.

Os testes usam relógio controlado: 72h exatas não avisam, 72h + 1 ms avisa, e o aviso não se repete.

## Trocar o agregador

O formato do RastreiaJá só existe em [`src/aggregator/rastreiaja.ts`](src/aggregator/rastreiaja.ts). O resto do código conhece a interface `TrackingAggregator` (`register`, `fetch`, `parseWebhook`) e o tipo `CarrierEvent`, com o status cru da transportadora. Para trocar de agregador, basta um arquivo novo que implementa a interface. Os testes rodam o **cliente HTTP real** sobre um servidor simulado no nível do `fetch` ([`fake-rastreiaja.ts`](src/aggregator/fake-rastreiaja.ts)), que devolve os eventos em ordem embaralhada.

## O que ficou de fora

- **Retry e backoff nas chamadas ao agregador:** hoje uma falha vira 502, e o job tenta de novo no ciclo seguinte.
- **Assinatura do webhook do agregador:** depende do agregador real.
- **Alerta de "não postado depois de N dias":** a marca prometeu enviar e não enviou. É outro relógio, que começa no cadastro.
- **Liberar o prazo do conteúdo quando o pacote é entregue:** o evento existe (`status = delivered`, `status_since`), mas a integração com o fluxo de campanha não foi feita.
- **Tabela de dialetos no código:** com mais transportadoras, ela iria para o banco, com alerta quando aparece um código `unknown` novo, para o time mapear.

## Uso de IA

<!-- revise e ajuste com as suas palavras antes de enviar -->
O código, os testes e este README foram escritos com o Claude (Claude Code). Eu revisei a tabela de status, a regra de status atual por histórico, a regra de atraso e a fronteira com o agregador, e rodei `npm test` e `npm run typecheck`.
