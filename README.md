# Igor · It Goes On Reading

[English README](README.en.md)

La lingua dell’interfaccia segue le preferenze del browser. **Lingua** permette di scegliere **Italiano**, **English** o **Automatica**. Il cambio ricarica la pagina. La scelta si salva su ciascun dispositivo. Per condividere una lingua specifica usa `?lang=it` o `?lang=en`.

## Telecomandi configurabili

### Easter egg

Fai tre clic o tocchi rapidi sull'icona di Igor nella schermata iniziale per aprire **WHEREPROMTER? THEREPROMPTER!**. Il gioco usa il copione corrente come sfondo quando disponibile. Il browser carica la pagina del gioco all'apertura e la rimuove alla chiusura. Il gioco gira in locale e non apre sessioni di sincronizzazione.

Apri **Configura telecomando**. Premi un tasto o muovi lo stick per vedere l'input ricevuto da Igor. Per associarlo a un comando, scegli **Testo** o **Slide**, seleziona l'azione e premi **Premi un tasto per assegnarlo**. Le due mappature si salvano nel browser del dispositivo che riceve i comandi. I pulsanti dei gamepad usano la numerazione mostrata nel test. In modalità Testo puoi assegnare ciascun verso di uno stick a **Scorri avanti** o **Scorri indietro**, con velocità proporzionale al movimento.

L'apprendimento funziona con tasti ricevuti dal browser e con gamepad che il browser riconosce. I telecomandi con protocollo Bluetooth proprietario richiedono un profilo dedicato.

## Telecomando Moman 2A32

In un browser con Web Bluetooth, fai cinque clic o tocchi rapidi sul titolo **Opzioni di lettura**. **Collega Moman** appare sotto **Specchiatura**. Sul tablet già in modalità schermo, apri prima le opzioni con un doppio tocco sul gobbo. Il pulsante usa il profilo BLE Moman 2A32 e può funzionare anche con dispositivi che espongono lo stesso servizio e inviano gli stessi comandi. Lo stick verticale scorre il copione in proporzione all’inclinazione. In modalità Gobbo, **Y** accelera e **A** rallenta. Nelle viste di presentazione, **Y** avanza e **A** torna alla slide precedente. Anche lo stick orizzontale cambia slide. **X** ingrandisce il testo, **B** lo rimpicciolisce, **OK** avvia o mette in pausa e **ON/OFF** torna all’inizio del copione. Chiudi le altre app connesse al Moman prima della prova.

## Sincronizzazione e risorse

Il dispositivo di controllo genera un codice di cinque caratteri e un QR per lo schermo. Se i browser possono comunicare direttamente, Igor usa WebRTC e mostra **Diretto** nel pannello operatore. Altrimenti Igor inoltra gli aggiornamenti via WebSocket e mostra **Via server**. Il VPS serve la pagina e gestisce l'abbinamento. Il collegamento diretto usa i candidati locali, quindi la possibilità di stabilirlo dipende anche dalle impostazioni della rete Wi-Fi.

Per impostazione predefinita il container Igor ha un tetto di 100 MiB e ammette fino a 300 sessioni. Puoi cambiarlo con `IGOR_MEMORY_LIMIT` nel file `.env`. Al limite Docker può terminare e riavviare il servizio, e le coppie devono abbinarsi di nuovo. Usa `docker stats igor-gobbo-1 prestiti-iulm-caddy-1` per misurare sia Igor sia il proxy durante una prova di carico. Il limite di Igor non include Caddy. I primi download del convertitore PowerPoint usano la banda del VPS e vengono serviti a flusso.

## Capacità e risorse

Il limite di 300 sessioni è un tetto di ammissione. La capienza reale va verificata sul VPS con il proxy, il relay e i materiali effettivi. La suite locale simula 300 coppie WebSocket e non misura la RAM del VPS. Altri limiti:

- `IGOR_IP_SESSIONS` e `IGOR_IP_SOCKETS` impediscono a un solo indirizzo IP di esaurire le sessioni (0 = nessun limite). Dietro Caddy Igor usa l'ultimo valore di `X-Forwarded-For`. Se molte persone condividono lo stesso Wi-Fi, appaiono come un solo IP: alza i due valori.
- I tentativi di codice sbagliati sono limitati per IP, così chi prova codici a caso non blocca gli altri.
- `https://igor.lorelive.org/healthz` risponde con sessioni, connessioni e RAM. Usalo con un monitor esterno (per esempio Uptime Kuma). Non c'è un healthcheck Docker interno perché avvierebbe un secondo processo Node dentro il limite di memoria.
- Aggiungi `encode zstd gzip` al blocco di Caddy: il server non comprime e i file della pagina e di PDF.js si riducono molto.
- Il kernel conteggia nel limite del container anche la cache dei file del convertitore PowerPoint serviti a flusso. È in parte recuperabile e `docker stats` può mostrare un valore più alto del processo.
- Per provare il carico usa `node test/load.cjs 1000 https://tuo-dominio/igor 30` da un'altra macchina, con un server di prova avviato con `IGOR_IP_SESSIONS=0 IGOR_IP_SOCKETS=0`. Non lanciarlo sul VPS di produzione.

## Aggiornare Igor sul VPS esistente

Il sito di produzione usa `https://igor.lorelive.org/`. Mantieni la configurazione Caddy e DNS esistente. Esegui l'aggiornamento quando nessuno sta usando il gobbo: il riavvio chiude le sessioni attive.

1. Dal PC, nella cartella in cui hai scaricato lo ZIP, caricalo usando lo stesso host con cui accedi via SSH. Sostituisci `HOST_VPS` con il tuo indirizzo.

   ```sh
   scp Igor-Studio-Moman.zip root@HOST_VPS:/tmp/
   ssh root@HOST_VPS
   ```

2. Sul VPS, controlla con quali file Compose è stato avviato il container attuale.

   ```sh
   cd /opt/igor
   docker inspect igor-gobbo-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
   docker inspect prestiti-iulm-caddy-1 --format '{{range $nome, $_ := .NetworkSettings.Networks}}{{println $nome}}{{end}}'
   ```

   Usa gli stessi file Compose del container attuale. I comandi seguenti assumono `compose.yaml` e `compose.caddy.yaml`. Se risulta solo `compose.yaml`, togli `-f compose.caddy.yaml` dai comandi. Se Compose chiede `CADDY_NETWORK`, esporta il nome della rete Docker condivisa con Caddy, per esempio `export CADDY_NETWORK=nome_rete`.

3. Verifica lo ZIP, salva una copia della directory e aggiorna i sorgenti. L'estrazione lascia al loro posto `.env` e l'eventuale configurazione locale di Caddy.

   ```sh
   unzip -t /tmp/Igor-Studio-Moman.zip &&
   tar -czf "/root/igor-prima-$(date +%Y%m%d-%H%M%S).tar.gz" -C /opt igor &&
   unzip -o /tmp/Igor-Studio-Moman.zip -x compose.caddy.yaml -d /opt/igor
   ```

4. Imposta il tetto previsto per il VPS e verifica la configurazione prima di costruire l'immagine. Le variabili esportate prevalgono su `.env` per questi comandi. Per rendere i valori permanenti, aggiorna le due chiavi corrispondenti nel tuo `.env`.

   ```sh
   export IGOR_MEMORY_LIMIT=100m IGOR_MAX_SESSIONS=300
   docker compose -f compose.yaml -f compose.caddy.yaml config -q &&
   docker compose -f compose.yaml -f compose.caddy.yaml build &&
   docker compose -f compose.yaml -f compose.caddy.yaml up -d --no-build
   ```

5. Controlla l'avvio e poi abbina due dispositivi dal sito pubblico.

   ```sh
   curl -fsS --retry 5 --retry-connrefused http://127.0.0.1:8787/healthz
   curl -fsS https://igor.lorelive.org/healthz
   docker stats --no-stream igor-gobbo-1 prestiti-iulm-caddy-1
   ```


## Uso con telefono, PC e tablet

1. Dal telefono o dal PC apri Igor e carica il materiale. Premi **Abbina schermo**.
2. Sul tablet apri Igor, scegli **Modalità schermo** e inserisci il codice. In alternativa scansiona il QR. Il codice dura cinque minuti, si usa una sola volta e non serve per le riconnessioni della stessa scheda.
3. Dal telefono o dal PC premi **Avvia il gobbo**. Da qui puoi avviare, mettere in pausa, regolare velocità e caratteri, scorrere il copione o cambiare slide. Igor apre una vista dedicata al controllo. Premi **Torna al materiale** per modificare i file o la specchiatura.
4. Per aprire direttamente la schermata con il codice, aggiungi `?schermo=1` all’indirizzo di Igor. Sul tablet trascina il testo per scorrere. Tocca una volta per mettere in pausa o riprendere, oppure due volte per aprire le opzioni di lettura. Il pannello comandi indica se il collegamento è **Diretto** o **Via server**.
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


### Uso con un solo dispositivo

Apri la pagina principale sul tablet, carica il materiale e scegli **Leggi su questo dispositivo**. Un tocco breve avvia o mette in pausa, il trascinamento scorre il copione e due tocchi rapidi aprono le opzioni. Da quelle opzioni puoi anche tornare al materiale.

### Recupero locale

Igor salva automaticamente il lavoro aperto nel browser e conserva fino a cinque lavori recenti. Usa **Riprendi ultima sessione** oppure apri un elemento da **Recenti**. Il gobbo riparte in pausa con posizione e impostazioni recuperate. I documenti salvati per il recupero restano nello stesso browser e indirizzo. Per un tablet usato come schermo potrebbe essere necessario generare un nuovo codice dopo aver ricaricato il dispositivo di controllo.
