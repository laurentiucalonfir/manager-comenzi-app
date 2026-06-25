# manager-comenzi-app workflow

## Deploy la Firebase Hosting + Functions

După fiecare modificare de cod, rulează în ordine:

1. `deploy.bat` — bump versiune, git commit, git push
2. `cmd /c "npm install"` în directorul `functions/` (dacă s-au schimbat dependențe)
3. `cmd /c "npx --yes firebase-tools deploy --only hosting"` — deploy hosting
4. `cmd /c "npx --yes firebase-tools deploy --only functions"` — deploy Cloud Functions

Userul trebuie să facă hard refresh (Ctrl+F5) pe ambele dispozitive după deploy.
