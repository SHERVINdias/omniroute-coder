/**
 * desktop/preload.js
 * ---------------------------------------------------------------------------
 * A deliberately tiny bridge. contextIsolation is on and nodeIntegration is
 * off, so the renderer has no Node access; this exposes only a couple of
 * read-only facts under window.omniroute. It grants NO filesystem, NO shell, and
 * NO arbitrary IPC — anything more would hand the web content powers the threat
 * model does not want it to have.
 */

"use strict";

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("omniroute", {
  isDesktop: true,
  appVersion: process.env.npm_package_version || null,
});

/*
 * Auto local sign-in.
 *
 * A desktop install is single-user and cannot email a sign-in code, so instead
 * of showing a login screen we sign in silently as a local account the first
 * time the app loads. Runs at most once per session: if a token is already
 * stored, do nothing. On success we store the token/user the way the app's own
 * sign-in does, then reload so the UI comes up already signed in.
 *
 * This runs in the preload (isolated world) but touches only localStorage,
 * fetch and location — the same web APIs the page uses — so it needs no extra
 * privilege and leaves contextIsolation intact.
 */
window.addEventListener("DOMContentLoaded", () => {
  let alreadySignedIn = false;
  try {
    alreadySignedIn = !!window.localStorage.getItem("auth_token");
  } catch {
    return;
  }
  if (alreadySignedIn) return;

  fetch("/api/auth/local", { method: "POST" })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || !data.token) return;
      try {
        window.localStorage.setItem("auth_token", data.token);
        window.localStorage.setItem("user", JSON.stringify(data.user));
      } catch {
        /* storage unavailable — the session cookie still carries auth */
      }
      window.location.reload();
    })
    .catch(() => {
      /* Not the desktop build, or offline — leave the normal UI in place. */
    });
});
