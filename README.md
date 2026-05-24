# SteamCoin Backend

Minimalny backend produkcyjnego kierunku dla Steam Inventory.

## Co robi

- `GET /health` - prosty healthcheck.
- `GET /progress` - globalny licznik monet + liczba aktywnych sesji.
- `POST /session/start` - tworzy serwerowa sesje gracza i uruchamia czas aktywnej gry.
- `POST /session/heartbeat` - podtrzymuje sesje i zapisuje naliczony czas.
- `POST /session/end` - zamyka sesje i pauzuje timery.
- `POST /round/chest-open` - weryfikuje Steam Web API ticket, sprawdza timer po stronie serwera, wywoluje Steam `IInventoryService/AddItem` i zapisuje grant jako idempotentny.

## Wymagane zmienne

Mozesz tez skopiowac `.env.example` jako punkt startowy.

```powershell
$env:STEAM_PUBLISHER_KEY="publisher_key_z_economy_permission"
$env:STEAM_APP_ID="3463540"
$env:STEAM_COIN_ITEMDEF_ID="TU_WPISZ_ITEMDEF_MONETY"
$env:SESSION_TIMEOUT_MS="120000"
$env:POWERUP_DURATION_MS="86400000"
$env:PRIMARY_TIMER_MS="3600000"
$env:OLD_CLOCK_TIMER_MS="7200000"
$env:PORT="8787"
```

## Start lokalny

```powershell
cd C:\Users\Winterlife\Documents\model AI\steamcoin-render-backend
npm start
```

## Deploy na Render

- Utworz web service z tego repozytorium
- Build command: `npm install`
- Start command: `npm start`
- Ustaw `STEAM_PUBLISHER_KEY` jako sekret po stronie Render
- Ustaw `STEAM_COIN_ITEMDEF_ID=1013`
- Ustaw `STEAM_APP_ID=3463540`
- Ustaw `TOTAL_COINS_GOAL=24000000`
- Ustaw `SESSION_TIMEOUT_MS=120000`
- Ustaw `POWERUP_DURATION_MS=86400000` jeśli chcesz zmienić domyślne 24h dla mirrora i hammera
- Ustaw `PRIMARY_TIMER_MS=3600000`
- Ustaw `OLD_CLOCK_TIMER_MS=7200000`
- `PORT` zostaw do wstrzykniecia przez Render

## Wazne

Klucz `STEAM_WEB_API_KEY` musi zostac tylko na serwerze. Nie wolno umieszczac go w Unity ani w buildzie wysylanym do graczy.

Ten backend jest pierwszym bezpiecznym szkieletem grantow Steam. `STEAM_PUBLISHER_KEY` jest tu uzywany zarowno do `AuthenticateUserTicket`, jak i do `IInventoryService/AddItem`. AddItem oczekuje listy `itemdefid[0]`, `itemdefid[1]` itd., wiec tutaj jest to juz przygotowane dla monety Steam.

Kolejny krok to podpiecie klienta Unity pod `POST /session/start`, `POST /session/heartbeat` i `POST /session/end`, zeby backend liczyl aktywny czas gry i nie ufal lokalnemu timerowi klienta.
