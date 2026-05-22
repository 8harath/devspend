import { copyFile, chmod } from 'fs/promises'
await copyFile('src/cli.ts', 'dist/cli.js')
await chmod('dist/cli.js', 0o755)
console.log('postbuild: dist/cli.js ready')
