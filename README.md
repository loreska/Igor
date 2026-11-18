# Igor · It Goes On Reading

## Sincronizzazione e risorse

Il dispositivo di controllo genera un codice di cinque caratteri e un QR per lo schermo. Se i browser possono comunicare direttamente, Igor usa WebRTC e mostra **Diretto** nel pannello operatore. Altrimenti Igor inoltra gli aggiornamenti via WebSocket e mostra **Via server**. Il VPS serve la pagina e gestisce l'abbinamento. Il collegamento diretto usa i candidati locali, quindi la possibilità di stabilirlo dipende anche dalle impostazioni della rete Wi-Fi.

Il container ha un limite di 100 MiB. Puoi cambiarlo con `IGOR_MEMORY_LIMIT` nel file `.env`. Al limite Docker può terminare e riavviare il servizio, e le coppie devono abbinarsi di nuovo. Usa `docker stats igor-gobbo-1 prestiti-iulm-caddy-1` per misurare sia Igor sia il proxy durante una prova di carico. Il limite di Igor non include Caddy. I primi download del convertitore PowerPoint usano la banda del VPS e vengono serviti a flusso.

## Sul VPS

Per usare **https://lorelive.org/igor/** con Caddy in Docker, estrai lo ZIP in una directory dedicata sul VPS. Individua il nome della rete del container Caddy con `docker inspect NOME_CONTAINER_CADDY --format '{{json .NetworkSettings.Networks}}'`. Poi esegui dalla directory di Igor:

```sh
export CADDY_NETWORK=nome_rete_caddy
docker compose -f compose.yaml -f compose.caddy.yaml up -d --build
```

Nel blocco esistente di `lorelive.org`, prima della gestione generica del sito, aggiungi:

```caddyfile
redir /igor /igor/ 308
handle_path /igor/* {
    reverse_proxy igor:8787
}
```

Se il sito usa un blocco `route`, inserisci queste direttive al suo interno prima del fallback. Valida e ricarica il Caddyfile usando il percorso effettivo nel container, in genere `/etc/caddy/Caddyfile`:

```sh
docker exec NOME_CONTAINER_CADDY caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec NOME_CONTAINER_CADDY caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Per la verifica HTTP usa una GET, perché il server di Igor serve la pagina via GET:

```sh
curl -fsS -D - -o /dev/null https://lorelive.org/igor/
```

Se Caddy gira direttamente sul VPS, usa il solo `docker compose up -d --build` e il blocco seguente con un sottodominio configurato nel DNS.

```caddyfile
igor.lorelive.org {
    reverse_proxy 127.0.0.1:8787
}
```

Per una prova locale con Node.js 24, usa `npm install` e `npm start`, poi apri `http://127.0.0.1:8787/`.
Per aggiornare da una versione precedente, esegui di nuovo `npm install` in locale oppure `docker compose up -d --build` sul VPS. Il pacchetto npm include il motore WebAssembly. La pagina deve essere aperta via HTTPS (oppure da localhost per sviluppo) e il proxy deve inoltrare le intestazioni COOP e COEP emesse dal server.

## Uso con telefono, PC e tablet

1. Dal telefono o dal PC apri Igor e carica il materiale. Premi **Abbina schermo**.
2. Sul tablet apri Igor, scegli **Modalità schermo** e inserisci il codice. In alternativa scansiona il QR. Il codice dura cinque minuti, si usa una sola volta e non serve per le riconnessioni della stessa scheda.
3. Dal telefono o dal PC premi **Apri anteprima**. Da qui puoi avviare, mettere in pausa, regolare velocità e caratteri, scorrere il copione o cambiare slide. Materiale e specchiatura restano disponibili accanto all’anteprima su desktop e sotto di essa su telefono.
4. Per aprire direttamente la schermata con il codice, aggiungi `?schermo=1` all’indirizzo di Igor. Sul tablet puoi usare **Schermo intero** quando il browser lo supporta. Il pannello comandi indica se il collegamento è **Diretto** o **Via server**.
## Importazione e tasti

- Word DOCX conserva formattazione strutturale come titoli, grassetto, corsivo ed elenchi. Togli la spunta alla formattazione per il testo semplice.
- Carica i PDF con testo selezionabile da **Copione**. Usa **Slide (PDF o PowerPoint)** per aprire direttamente la modalità slide. Le scansioni sono disponibili come pagine. Questa versione non contiene OCR.
- Carica un PDF da **Slide** per l'apertura diretta. Se scegli un `.pptx`, il browser chiede conferma prima di caricare il convertitore locale, circa 248 MB di risorse al primo utilizzo. Il browser può conservare il motore in cache. Seleziona **Slide + note** o **Solo note** per usare le note del relatore. La conversione dipende dalle risorse del dispositivo e dai font del motore. Per una resa fedele, puoi esportare il PDF da PowerPoint.
- Un telecomando Bluetooth che emula una tastiera può usare Spazio per avvio/pausa, frecce su/giù per spostarsi, frecce sinistra/destra o Pagina Su/Giù per cambiare slide, + e − (tasto del trattino) per la velocità.

Il file PPTX viene elaborato dal browser del dispositivo. Il limite del PPTX da convertire è 40 MB. Il VPS serve i file statici del motore quando il browser li richiede, inoltra il contenuto della vista attiva e i comandi quando è in uso il collegamento Via server, anche mentre i dispositivi negoziano il canale diretto. Condividi il codice o il QR solo con il dispositivo su cui vuoi mostrare il contenuto. Dopo il riavvio del servizio ricarica la pagina e abbina di nuovo lo schermo.


## Sorgenti e verifica locale

- Requisiti: Node.js 24 e npm. Installa le dipendenze bloccate con `npm ci`.
- Avvia con `npm start` e apri `http://127.0.0.1:8787/`.
- Da un altro terminale esegui `npm test`. I test controllano gli asset effettivi del convertitore e simulano 300 coppie WebSocket sulla macchina locale. La simulazione usa 600 socket client oltre al server e non va eseguita sul VPS di produzione.
- Per verificare WebRTC usa due dispositivi sulla stessa rete, abbinali e cerca **Diretto** nel pannello comandi. Ripeti su reti separate per provare **Via server**. Verifica anche la riconnessione e il cambio slide. La prova locale del relay non misura la RAM del VPS.
- `server.cjs` serve pagina e asset, `relay.cjs` gestisce abbinamento e inoltro, `public/` contiene l'interfaccia e la logica dei dispositivi.
- Per creare il repository, estrai l'archivio e caricane i file alla radice, inclusi `.gitignore` e `.dockerignore`. Conserva `package-lock.json`. Tieni configurazioni locali, credenziali e `.env` fuori dal repository.
- Per aggiornare il VPS esistente, conserva il suo `.env`, aggiorna i sorgenti, poi esegui `docker compose -f compose.yaml -f compose.caddy.yaml up -d --build`. Durante il riavvio le sessioni attive vanno abbinate di nuovo.

