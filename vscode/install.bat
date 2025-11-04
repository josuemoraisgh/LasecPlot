@REM 1) Limpar lock e node_modules (PowerShell)
rd /s /q node_modules
del package-lock.json

@REM 2) Instalar com as versões fixadas
npm install

@REM 3) (opcional) rodar lint
npm run lint

@REM 4) Compilar
	npm run compile


@REM npx @vscode/vsce package --target win32-x64
@REM code --install-extension josuemoraisgh.lasecplot-x.y.z.vsix --force