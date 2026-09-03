# AutoCliper ko Hostinger VPS pe chalane ki poori guide

Ye guide bilkul simple hai — copy-paste karte jao, app chal jayegi.
Time lagega: 15-20 minute.

---

## Step 0 — VPS taiyaar karo (sirf pehli baar)

1. Hostinger ke **hPanel** me jao → **VPS** → apna VPS kholo
2. Operating system: **Ubuntu 22.04** (ya 24.04) — **plain/clean wala** chuno,
   koi "panel" (CyberPanel/CloudPanel wagera) **mat** chuno
3. VPS ka **IP address** aur **root password** note kar lo
4. RAM kam se kam **4 GB** ho to best (build ke waqt chahiye hota hai)

## Step 1 — Server me ghuso (terminal kholo)

Sabse aasan: hPanel me VPS ke page pe **"Browser terminal"** button hai — usse kholo
aur `root` + apna password daal ke login karo.

(Ya apne computer se: `ssh root@TERA_VPS_IP`)

## Step 2 — Ek hi command chalao

Terminal me ye paste karo aur Enter dabao:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/thedevlovable/autocliper/main/deploy/hostinger-setup.sh)
```

> Agar repo **private** hai to pehle GitHub pe repo ko public karo, ya clone URL
> poocha jaye tab token wala URL dena:
> `https://TOKEN@github.com/thedevlovable/autocliper.git`

Script tumse ye poochega — taiyaar rakho:

| Sawal | Kya bharna hai |
|---|---|
| Your domain | `autocliper.com` (bina https ke) |
| Git repo URL | Enter daba do (default sahi hai) |
| ZYLA_API_KEY | apni Zyla key |
| DEEPGRAM_API_KEY | apni Deepgram key |
| ZAPUPI_ZAP_KEY | apni ZapUPI key |
| RESEND_API_KEY | password-reset email ke liye — resend.com se free key (optional) |
| ADMIN_EMAILS | apna email — is email se signup karte hi admin ban jaoge |

Baaki sab (database, storage, SSL, service) script **khud** bana dega.
5-10 minute chalega — chalne do.

## Step 3 — Domain ko VPS pe point karo

Jahan bhi tumhara domain hai (Hostinger Domains → DNS / Cloudflare):

1. **A record** banao: naam `@` → value = **VPS ka IP**
2. **A record** banao: naam `www` → value = **wahi IP**
3. Purane records jo kahin aur point karte hain (jaise Replit wale) — **hata do**

DNS point hote hi 2-10 minute me **https://** apne aap chalu ho jayega
(SSL certificate script wala Caddy khud le leta hai — kuch nahi karna).

## Step 4 — Check karo

- Browser me kholo: `https://autocliper.com` — homepage dikhna chahiye
- ADMIN_EMAILS wale email se **signup** karo → `https://autocliper.com/admin` khul jayega

---

## Roz ke kaam (cheat-sheet)

| Kaam | Command (root terminal me) |
|---|---|
| Naya code lagana (GitHub se) | `bash /opt/autocliper/deploy/update.sh` |
| App restart | `systemctl restart autocliper` |
| Live logs dekhna | `journalctl -u autocliper -f` (band karne ko Ctrl+C) |
| App ki health | `curl -s http://127.0.0.1:3000/api/healthz` |

## Zaroori baatein

- **Clips ka storage**: VPS ki apni disk pe save hote hain (`/var/lib/autocliper/clips`) —
  permanent hai, restart pe kuch nahi jata. Disk full na ho iska dhyan rakhna
  (hPanel me disk usage dikhta hai).
- **Payments (ZapUPI)**: domain wahi hai to webhook me kuch nahi badalna.
- **Purana data**: Replit wale server ke users/credits/clips apne aap VPS pe
  **nahi** aayenge. Fresh start hoga. Purana data chahiye to mujhe bolna —
  migration main kara dunga.
- **Replit wala band karne se pehle** VPS pe sab test kar lena (signup, clip
  banana, payment) — jab sab chale tabhi Replit deployment band karna.

## Kuch gadbad ho to

| Problem | Matlab / Ilaaj |
|---|---|
| Browser me site nahi khul rahi | DNS abhi point nahi hua — 10-15 min ruko, `A record` check karo |
| `https` pe "certificate" error | DNS naya-naya point hua hai — Caddy 1-2 min me khud le lega |
| Site 502 de rahi hai | App gir gayi — `journalctl -u autocliper -n 50` se error dekho, `systemctl restart autocliper` |
| Build ke waqt "killed" aaya | RAM kam hai — VPS me swap on karo ya 4GB+ plan lo |

Kuch bhi phase to yahan (Replit Agent) screenshot bhej dena — main bata dunga.
