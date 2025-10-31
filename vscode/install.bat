@REM CALL npm install
CALL npm run compile

@REM npx @vscode/vsce package --target win32-x64
@REM code --install-extension josuemoraisgh.lasecplot-x.y.z.vsix --force