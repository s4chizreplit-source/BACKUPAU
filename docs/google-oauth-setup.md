# Google OAuth Setup for Production

This document explains how to whitelist the production domain in Google Cloud Console so Google sign-in works on the live site (`https://clipai-sourcezip.replit.app`).

## Why this is needed

Clerk handles the OAuth flow, but Google's own allowlist must also include your production URL. Without it, users will see a **`redirect_uri_mismatch`** error when they click "Sign in with Google" on the deployed app.

## Steps

### 1. Open Google Cloud Console

Go to [https://console.cloud.google.com](https://console.cloud.google.com) and select the project that owns the OAuth client used by Clerk.

### 2. Navigate to the OAuth credentials

**APIs & Services → Credentials**

Find the **OAuth 2.0 Client ID** that Clerk uses (typically named something like "Web client" or your app name).

### 3. Add Authorized JavaScript origins

Under **Authorized JavaScript origins**, click **Add URI** and add:

```
https://clipai-sourcezip.replit.app
```

### 4. Add Authorized redirect URIs

Under **Authorized redirect URIs**, click **Add URI** and add the Clerk SSO callback URL:

```
https://clipai-sourcezip.replit.app/sso-callback
```

> **Note:** Clerk may also use a path under its own `clerk.accounts.dev` domain. Check the Clerk Auth pane in the workspace toolbar for the exact redirect URIs your instance expects, and add any additional ones listed there.

### 5. Save

Click **Save** at the bottom of the credentials page. Changes propagate within a few minutes.

### 6. Verify

Visit `https://clipai-sourcezip.replit.app`, click **Sign in with Google**, and confirm the OAuth screen loads and completes without a `redirect_uri_mismatch` error.

## Summary of URLs to whitelist

| Type | Value |
|------|-------|
| Authorized JavaScript origin | `https://clipai-sourcezip.replit.app` |
| Authorized redirect URI | `https://clipai-sourcezip.replit.app/sso-callback` |
