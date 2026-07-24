# ShadowCrypt — Usage Guide

This guide covers everything you need to know as an end user of ShadowCrypt.

---

## Table of Contents

- [Creating an Account](#creating-an-account)
- [Logging In](#logging-in)
- [Recovery Phrase](#recovery-phrase)
- [Sending Messages](#sending-messages)
- [Replying to Messages](#replying-to-messages)
- [Sharing Images](#sharing-images)
- [Sending Voice Messages](#sending-voice-messages)
- [Adding Contacts](#adding-contacts)
- [Contact Requests](#contact-requests)
- [Blocking & Unblocking Users](#blocking--unblocking-users)
- [Settings & Profile](#settings--profile)
- [Password Management](#password-management)
- [Forgot Password](#forgot-password)
- [Account Deletion](#account-deletion)
- [Privacy & Security Tips](#privacy--security-tips)

---

## Creating an Account

1. Open ShadowCrypt in your browser.
2. Click **Create Account**.
3. Enter a **username** (3–32 characters, letters/numbers/underscores only).
4. Click **Continue**.
5. Enter a **password** that meets all requirements:
   - 6–20 characters
   - At least 1 uppercase letter
   - At least 1 lowercase letter
   - At least 1 number
   - At least 1 special character (e.g. `!`, `@`, `#`)
6. Watch the live strength meter — aim for **Strong** or **Very Strong**.
7. Click **Create Account**.
8. **Save your Recovery Phrase** — a modal will appear with your 12-word BIP-39 mnemonic. Write it down or download the text file. This is the only way to recover your account if you forget your password.

---

## Logging In

1. Enter your **username** and **password**.
2. Click **Sign In**.

> **First-time login for migrated accounts**: If you registered before the password system was updated, you will be prompted to create a new password. This is a one-time migration step.

---

## Recovery Phrase

Your recovery phrase is a 12-word sequence generated when your account is created. It is:
- Stored **encrypted in your browser** (never sent to the server as plaintext).
- Required to reset your password if you forget it.
- Shown only once during registration — save it immediately.

**To view your phrase later:**
1. Go to **Settings** → **Recovery Phrase**.
2. Enter your current password to reveal the phrase.

**To regenerate your phrase:**
1. Go to **Settings** → **Recovery Phrase** → **Regenerate**.
2. Confirm the action — your old phrase will be invalidated immediately.
3. Save the new phrase.

> **Warning:** If you lose your recovery phrase and forget your password, your account **cannot be recovered**.

---

## Sending Messages

1. Select a contact from the sidebar.
2. Type your message in the input box at the bottom.
3. Press **Enter** or click the **Send** button.

All messages are encrypted locally before being sent. The server never sees plaintext.

---

## Replying to Messages

1. Hover over any message and click the **Reply** icon (or long-press on mobile).
2. A preview of the quoted message appears above the input box.
3. Type your reply and send.
4. Click the **×** on the preview bar to cancel the reply.

---

## Sharing Images

1. Click the **image** icon in the chat input area.
2. Select an image file from your device (max 10 MB).
3. Preview the selected image, then click **Send**.

> **Daily limit**: Each user can send up to **10 images per day** (resets at midnight UTC).

---

## Sending Voice Messages

1. Click the **microphone** icon in the chat input area to start recording.
   - A red recording indicator appears with a live elapsed timer.
2. Click the **stop** (square) button to finish and automatically send the voice message.
   - Click the **cancel** (mic-off) button to discard the recording without sending.

> **Daily limit**: Each user can record and send up to **10 minutes of voice per day** (resets at midnight UTC). The mic button shows the remaining quota in its tooltip.

**How voice messages are secured:**
- Your audio is recorded using the Opus codec (Constrained VBR, 32 kbps ceiling) in a WebM container — efficient and private.
- The recording is encrypted with AES-256-GCM entirely in your browser before upload. The plaintext audio never touches the server.
- The decryption key travels inside the Double Ratchet ciphertext — the relay and storage service see only opaque encrypted blobs.
- Audio is stored in a private bucket and accessed via short-lived signed URLs (1-hour expiry).

---

## Adding Contacts

1. Click the **+** (Add Contact) button in the sidebar.
2. Enter the username of the person you want to add.
3. Click **Send Request**.

The other person will receive a contact request and must accept it before you can exchange messages.

---

## Contact Requests

### Incoming Requests

- A notification badge appears on the sidebar when you have pending requests.
- Click the **Requests** section to see incoming requests.
- Click **Accept** to add the contact, or **Decline** to reject.

### Outgoing Requests

- View pending outgoing requests in the **Requests** panel.
- You can cancel an outgoing request before it is accepted.

---

## Blocking & Unblocking Users

**To block a user:**
- Open a conversation, click the contact's name or the **⋮** menu, and select **Block User**.

**To unblock a user:**
1. Go to **Settings** → **Blocked Users**.
2. Find the user and click **Unblock**.

Blocked users cannot send you contact requests or messages.

---

## Settings & Profile

Access **Settings** from the sidebar (gear icon or your avatar).

| Setting | Description |
|---|---|
| **Avatar** | Upload a profile picture (max 2 MB). Toggle privacy to hide it from non-contacts. |
| **Bio** | Set a short bio visible to your contacts (max 160 characters). |
| **Username** | Change your username once every 30 days. |
| **Recovery Phrase** | View or regenerate your BIP-39 mnemonic. |
| **Blocked Users** | Manage your block list. |
| **Delete Account** | Permanently delete your account and all associated data. |

---

## Password Management

ShadowCrypt does **not** use email for authentication. Passwords are used locally to derive the vault encryption key.

**Requirements:**
- 6–20 characters
- Must contain uppercase, lowercase, number, and special character.

---

## Forgot Password

If you have forgotten your password but have your **recovery phrase**:

1. Click **Forgot Password** on the login screen.
2. Enter your **username**.
3. Enter your **12-word recovery phrase** (all lowercase, space-separated).
4. Set a **new password**.
5. Click **Reset Password**.

> **Warning:** After a password reset, your locally encrypted vault is cleared. Your message history on the current device will be lost (messages are already deleted from the relay). Contacts are re-synced from the server.

---

## Account Deletion

1. Go to **Settings** → **Delete Account**.
2. Enter your current password to confirm.
3. Click **Delete Account** and confirm the dialog.

This permanently deletes:
- Your Supabase Auth account.
- Your profile, contacts, and all relay messages.
- Your local vault (IndexedDB) is cleared from the browser.

This action **cannot be undone**.

---

## Privacy & Security Tips

- **Use a strong, unique password.** ShadowCrypt uses Argon2id — a strong password makes brute-force attacks computationally infeasible.
- **Save your recovery phrase offline.** Write it on paper or store it in a password manager. Do not save it in plain text on the same device.
- **Log out on shared devices.** Your vault key is held in `sessionStorage` during an active session. Always log out and close the tab when using a shared or untrusted machine.
- **Verify contact fingerprints.** ShadowCrypt generates a public key fingerprint for each user. Compare fingerprints with your contacts via a side channel to confirm you are not talking to an impostor.
- **Keep your browser updated.** ShadowCrypt relies on Web Crypto APIs that are continuously improved in modern browsers.
- **Notifications are anonymous.** ShadowCrypt push notifications never reveal who sent you a message — they only alert you to check the app.
