# manager-comenzi-app workflow

## Deploy la Firebase Hosting

După fiecare modificare de cod, rulează în ordine:

1. `deploy.bat` — bump versiune, git commit, git push
2. `cmd /c "npx --yes firebase-tools deploy --only hosting"` — deploy efectiv la Firebase

Userul trebuie să facă hard refresh (Ctrl+F5) pe ambele dispozitive după deploy.
