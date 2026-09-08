# Деплой bot-pol на AWS (один EC2)

Цей проєкт **не** ставиться як старий Python-бот. Там був один `python main.py` і SQLite. Тут — **Next.js-дашборд**, **PostgreSQL** і **Redis**. Paper/collect крутяться **всередині** процесу дашборду після кнопки **Старт**. Окремий `worker:paper` / `collector:live` через systemd **не вмикайте** — будуть подвійні філи й подвійні WebSocket.

Локальний Windows-workflow не чіпайте: як і раніше `docker compose up -d` + `npm run dev`.

Terraform у `infra/aws` (ECS, ALB, RDS) **не запускайте** — це $70–90/міс.

## Що ставити

| Сервіс | Потрібен? |
| --- | --- |
| EC2 Ubuntu (EU) | Так — єдиний хостинг 24/7 |
| PostgreSQL на цьому ж EC2 | Так (`apt`) |
| Redis на цьому ж EC2 | Так (`apt`), з AOF на диск |
| Docker / ECS / ALB / S3 / Lambda / Vercel | Ні |
| RDS / ElastiCache | Ні |

```
Ваш ПК (Windows) ──SSH──▶ EC2 Ubuntu (eu-central-1)
                              ├─ systemd postgresql
                              ├─ systemd redis-server   (appendonly)
                              └─ systemd botpol-web     → npm start :3000
                                    └─ після Старт: collect + paper у цьому ж процесі
```

Дашборд **без пароля**. Порт 3000 лише з вашого IP, не `0.0.0.0/0`.

## Вартість

- **t3.small** (2 GB) у Frankfurt — орієнтир **~$15/міс**. Це безпечний мінімум: Next + Postgres + Redis на 1 GB часто ловить OOM.
- **t3.micro** (Free Tier, 1 GB) + **2 GB swap** — дешевше, але може підлагувати. Якщо `dmesg` покаже Out of memory — одразу змінити тип на t3.small, не ставити другий інстанс.
- Після Free Tier один micro ≈ $8–10/міс без трафіку/диску зверху.

Не ставте другий EC2 «про запас».

## 1. Акаунт AWS

1. [aws.amazon.com](https://aws.amazon.com) → Create an AWS Account (Personal). Картка обов’язкова.
2. Billing → Free Tier alerts + бюджет **$15/міс**.
3. Регіон консолі: **eu-central-1 (Frankfurt)** або **eu-north-1 (Stockholm)**.
4. **Не** `us-east-1` / `us-west-2`: Binance дає **451 Restricted location**, API (баланс, ордери, prediction) не працює.

## 2. Створити EC2

EC2 → Launch instance:

| Поле | Значення |
| --- | --- |
| Name | botpol |
| AMI | Ubuntu Server 22.04 LTS |
| Type | **t3.small** (або t3.micro + swap, див. вище) |
| Key pair | новий `botpol-key`, формат `.pem`, зберегти файл |
| Storage | 30 GB gp3 |

Security group:

| Type | Port | Source |
| --- | --- | --- |
| SSH | 22 | **My IP** |
| Custom TCP | 3000 | **My IP** (дашборд) |

Не відкривайте 5432 і 6379 в інтернет.

Після Launch запишіть Public IPv4.

**Elastic IP:** EC2 → Elastic IPs → Allocate → Associate на інстанс. Інакше IP зміниться після Stop/Start, Binance IP-whitelist і SSH зламаються.

Цей Elastic IP потім додайте в обмеження Binance API key (IP access).

## 3. SSH з Windows

Покладіть `.pem` у `%USERPROFILE%\.ssh\` і обмежте права:

```powershell
icacls "$env:USERPROFILE\.ssh\botpol-key.pem" /inheritance:r
icacls "$env:USERPROFILE\.ssh\botpol-key.pem" /grant:r "$($env:USERNAME):(R)"
```

```powershell
ssh -i "$env:USERPROFILE\.ssh\botpol-key.pem" ubuntu@ВАШ_PUBLIC_IP
```

Перший раз: `yes` → Enter.

## 4. Swap + пакети (на EC2)

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

sudo apt update && sudo apt upgrade -y
sudo apt install -y git postgresql redis-server curl
```

Node 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.x
```

Postgres (пароль поставте свій, не лишайте `botpol` у проді):

```bash
sudo -u postgres psql -c "CREATE USER botpol WITH PASSWORD 'СИЛЬНИЙ_ПАРОЛЬ';"
sudo -u postgres psql -c "CREATE DATABASE botpol OWNER botpol;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE botpol TO botpol;"
```

Redis лише localhost + запис на диск (щоб Старт пережив ребут):

```bash
sudo sed -i 's/^#\?appendonly no/appendonly yes/' /etc/redis/redis.conf
sudo systemctl enable --now postgresql redis-server
sudo systemctl restart redis-server
```

Перевірка: `sudo ss -lptn | grep -E '5432|6379'` — має слухати `127.0.0.1`, не `0.0.0.0`.

## 5. Код на сервер

Репо: `https://github.com/Yurenko/predict.git` (приватне — варіант B).

**Варіант A — публічне:**

```bash
cd ~
git clone https://github.com/Yurenko/predict.git
cd predict
```

**Варіант B — приватне (рекомендовано):** на EC2

```bash
ssh-keygen -t ed25519 -C "botpol-ec2" -f ~/.ssh/botpol_deploy -N ""
cat ~/.ssh/botpol_deploy.pub
```

Публічний ключ → GitHub → repo **Settings → Deploy keys → Add** (read-only). Потім:

```bash
cd ~
GIT_SSH_COMMAND='ssh -i ~/.ssh/botpol_deploy -o IdentitiesOnly=yes' \
  git clone git@github.com:Yurenko/predict.git
cd predict
```

**Варіант C — scp з Windows** (якщо git ще не запушений):

```powershell
scp -i "$env:USERPROFILE\.ssh\botpol-key.pem" -r "E:\My projects\predict" ubuntu@ВАШ_IP:~/predict
```

На сервері **не** копіюйте `node_modules`, `.next`, `.env`. Якщо тягнете scp усього дерева — на EC2: `rm -rf node_modules .next`.

`.env`:

```bash
cd ~/predict
cp .env.example .env
nano .env
```

Обов’язково (хости **127.0.0.1**, не `postgres`/`redis` з Docker):

```env
DATABASE_URL=postgresql://botpol:СИЛЬНИЙ_ПАРОЛЬ@127.0.0.1:5432/botpol?schema=public
REDIS_URL=redis://127.0.0.1:6379

LIVE_TRADING_ENABLED=false
TRADING_MODE=PAPER
NODE_ENV=production

BINANCE_PAPER_API_KEY=...
BINANCE_PAPER_API_SECRET=...
BINANCE_PREDICTION_WALLET_ADDRESS=0x...

BANKROLL_USDT=40
MAX_POSITION_PCT=5
MAX_SIMULTANEOUS_POSITIONS=3

RAW_DATA_DIR=/home/ubuntu/predict/data/raw
LOG_LEVEL=info
```

`LIVE_*` ключі не заповнюйте, поки paper на сервері не стабільний. `npm run dev:live` на EC2 не потрібен.

Збірка (`tsx` у devDependencies — ставте **повний** `npm ci`, не `--omit=dev`):

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npx prisma db seed
npm run build
mkdir -p data/raw
```

Перевірка:

```bash
PORT=3000 npm start
# з ПК: http://ВАШ_IP:3000/api/health
# Ctrl+C
```

Не запускайте `docker compose -f docker-compose.app.yml` — там окремі worker-контейнери, які дублюють paper.

## 6. Автозапуск 24/7

Один сервіс — дашборд. Старт/Стоп лишаються кнопками в UI.

```bash
sudo cp ~/predict/deploy/systemd/botpol-web.service /etc/systemd/system/
sudo nano /etc/systemd/system/botpol-web.service   # шлях, якщо не /home/ubuntu/predict
sudo systemctl daemon-reload
sudo systemctl enable --now botpol-web
sudo systemctl status botpol-web
```

Має бути `active (running)`. Логи: `journalctl -u botpol-web -f`.

У браузері з вашого IP: `http://ВАШ_IP:3000` → стратегії → **Старт**.

Після ребута EC2 systemd підніме Postgres, Redis і дашборд. Якщо Redis зберіг `desired=running`, record-цикл підхопиться сам (`src/instrumentation.ts`). Якщо ні — ще раз **Старт**.

**Не вмикайте** окремо:

- `npm run worker:paper`
- `npm run worker:live`
- `npm run worker:record`
- `trading-bot-paper.service` зі старого бота

Live (`TRADING_MODE=LIVE`) на цьому інстансі не вмикайте, поки paper не перевірений.

## 7. Оновлення коду (не ламає локальний проєкт)

На ПК закомітьте й запуште в GitHub. На EC2:

```bash
cd ~/predict
GIT_SSH_COMMAND='ssh -i ~/.ssh/botpol_deploy -o IdentitiesOnly=yes' git pull
npm ci
npx prisma migrate deploy
npm run build
sudo systemctl restart botpol-web
```

Після рестарту перевірте `/api/health` і що в UI знову **Старт** (або цикл уже running).

Ніколи не робіть на сервері `prisma migrate dev` і не копіюйте `.env` назад на ПК.

## Типові проблеми

| Симптом | Що перевірити |
| --- | --- |
| SSH timeout | SG порт 22, Source = My IP (IP провайдера міняється) |
| Permission denied (publickey) | той самий `.pem`, користувач `ubuntu` |
| Binance 451 | регіон не США |
| `Invalid API-key, IP` | Elastic IP у whitelist ключа + Prediction SAS |
| Дашборд не відкривається | порт 3000 = My IP, `systemctl status botpol-web` |
| Подвійні угоди | не запущений другий paper/collector |
| OOM / процес зник | `dmesg \| tail`, swap, апгрейд на t3.small |
| Порожні ринки | Старт натиснутий, логи collector у `journalctl -u botpol-web` |
| Бот мовчить після reboot | `systemctl is-enabled botpol-web`, потім Старт |

## Бекап (пізніше)

Поки диск EC2. Коли з’явиться PnL, який шкода втратити:

```bash
sudo -u postgres pg_dump botpol | gzip > ~/botpol-$(date +%F).sql.gz
```

S3 можна додати окремо; для старту не потрібно.
