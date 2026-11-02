# Awsta

Awsta is a Discord bot that can answer prefixed `.ask` commands using the bot
operator's ChatGPT plan through Sign in with ChatGPT.

## Setup

1. Copy `.env.example` to `.env` and set `DISCORD_TOKEN`.
2. Run `npm install` and `npm start`.
3. On first launch, open the sign-in URL printed in the terminal and authorize
   Awsta. Credentials are stored outside the project in
   `~/.config/awsta/chatgpt.json` with owner-only file permissions.

Set `CHATGPT_MODEL` to choose a model available to the signed-in account.

## Discord permissions

- Send Messages
- Manage Messages
- Embed Links
- Attach Files
- Add Reactions
- Bypass Slowmode

Calculated permission integer field: `4503599627429952`, invite URL:
`https://discord.com/oauth2/authorize?client_id=1566608581418295348&permissions=4503599627429952&integration_type=0&scope=bot`
