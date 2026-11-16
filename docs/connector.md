# Use Ariya Lab from Claude

You can make your story videos by talking to Claude. Claude uses your Ariya Lab account, your projects and your credits, the same as the website.

## Your connector URL

```
<APP_URL>/api/mcp
```

`<APP_URL>` is the address of Ariya Lab, the same value as the `APP_URL` setting of the deployment, for example `https://ariyalab.com/api/mcp`. Use exactly this URL. It must start with `https://` and end with `/api/mcp`.

## Claude on the web or desktop (claude.ai)

1. Open **Settings → Connectors**.
2. Choose **Add custom connector**.
3. Name it `Ariya Lab` and paste the connector URL.
4. Choose **Add**, then **Connect**.
5. Sign in to Ariya Lab if you are asked, check what Claude will be allowed to do, and choose **Allow**.

In a chat, turn on Ariya Lab from the tools menu, then ask, for example: "Make a 30 second video for my barbershop booking app."

## Claude Code

Run this in a terminal, with your connector URL:

```
claude mcp add --transport http ariya-lab <APP_URL>/api/mcp
```

Then start Claude Code, type `/mcp`, choose **ariya-lab** and **Authenticate**. Your browser opens the Ariya Lab sign-in and approval page. Choose **Allow** and go back to the terminal.

## What Claude can do

Claude follows the same steps as the website: create a project, break down a reference video, write and change the script, make the characters, the storyboard, the narration, the music and the video clips, put the video together and give you the link.

Writing the script and characters, pictures, clips, the voice and the final video take a little while. Claude starts them and checks back until they are done.

## Credits

Claude spends the same credits as the website at the same prices. Before anything that costs credits (the project fee, extra pictures, extra narration or music, the video clips), Claude tells you the price and waits for your yes. Nothing is charged until you agree.

## Disconnect

On the website, open **Connected apps** and choose **Disconnect** next to Claude. You can also remove the connector in Claude's settings, or with `claude mcp remove ariya-lab` in Claude Code.
