services:
  - type: web
    name: absoracloud-api
    runtime: node
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: 3000
      - key: APP_DOMAIN
        value: absoracloud.qzz.io
      - key: API_URL
        value: https://absoracloud.onrender.com
      - key: JWT_SECRET
        sync: false
      - key: WORKER_SECRET
        sync: false
      - key: CLOUDFLARE_API_TOKEN
        sync: false
      - key: CLOUDFLARE_ACCOUNT_ID
        sync: false
      - key: CLOUDFLARE_DOMAIN
        value: astrocore.qzz.io
      - key: D1_DB_ID
        sync: false
      - key: D1_DB_1_ID
        sync: false
      - key: D1_DB_2_ID
        sync: false
      - key: D1_DB_3_ID
        sync: false
      - key: UPSTASH_REDIS_URL
        sync: false
      - key: UPSTASH_REDIS_TOKEN
        sync: false
      - key: KAGGLE_USERNAME
        sync: false
      - key: KAGGLE_KEY
        sync: false
      - key: GITHUB_OWNER
        value: lunarhost520
      - key: GITHUB_REPO
        value: Absoracloud
