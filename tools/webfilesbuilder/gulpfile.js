const gulp = require('gulp');
const fs = require('fs-extra');
const zlib = require('zlib');
const concat = require('gulp-concat');
const path = require('path');
const htmlmin = require('gulp-htmlmin');
const websrc = '../../src/websrc/';
const webh = `../../src/webh/`;
const prDir = `${websrc}process/`;
const fnDir = `${prDir}final/`;
const gzDir = `${prDir}gzip/`;
const directories = [
    websrc,
    webh,
    prDir,
    fnDir,
    gzDir
];
const mn = 'required';

// The web UI's scripts (src/websrc/js), concatenated in this order into the
// one served js/esprfid.js: plain scripts sharing one global scope, no module
// loader. state.js comes first (shared variables), main.js last (start-up).
const UI_SCRIPTS = ['state.js', 'policy.js', 'ui.js', 'transport.js', 'settings.js',
    'status.js', 'network.js', 'hardware.js', 'general.js', 'mqtt.js', 'ntp.js',
    'users.js', 'logs.js', 'backup.js', 'main.js'];

// Recreate output directories (destructive)
const ensureDirs = (cb) => {
    console.log('RECREATE OUTPUT DIRECTORIES (destructive of: webh & process)');
    fs.removeSync(webh);
    fs.removeSync(prDir);
    directories.forEach(dir => {
        fs.ensureDirSync(dir);
    });
    cb();
};

// Concatenate the UI scripts in UI_SCRIPTS order and minify them into one
// file. Fails if a script in the folder is not listed (or a listed one is
// missing), so nothing is left out of the bundle unnoticed.
function bundleUI(srcFolder, destFile, cb) {
    const present = fs.readdirSync(srcFolder).filter((f) => f.endsWith('.js')).sort();
    const listed = [...UI_SCRIPTS].sort();
    if (JSON.stringify(present) !== JSON.stringify(listed)) {
        return cb(new Error(`UI scripts ${present} do not match UI_SCRIPTS ${listed}`));
    }
    const source = UI_SCRIPTS.map((f) => `// ${f}\n` + fs.readFileSync(path.join(srcFolder, f), 'utf8')).join('\n');
    const out = require('uglify-js').minify(source);
    if (out.error) {
        return cb(out.error);
    }
    fs.writeFileSync(destFile, out.code);
    cb();
}

// Concat files into a single file.
function merge(srcFolder, fileType, destDir, outputFile) {
    return gulp.src(`${srcFolder}*.${fileType}`).pipe(concat({
        path: outputFile,
        stat: {
            mode: 0o666
        }
    })).pipe(gulp.dest(destDir));
}

// Gzip files
function gzip(srcFile, destFile, cb) {
    const input = fs.readFileSync(srcFile);
    const output = zlib.gzipSync(input, { level: 9 });
    fs.writeFileSync(destFile, output);
    cb();
}

// Create byte arrays of gzipped files
function byteArray(source, destination, name, cb) {
    const arrayName = name.replace(/\.|-/g, "_");
    const data = fs.readFileSync(source);
    const wstream = fs.createWriteStream(destination);
    wstream.write(`#define ${arrayName}_len ${data.length}\n`);
    wstream.write(`const uint8_t ${arrayName}[] PROGMEM = {`);
    for (let i = 0; i < data.length; i++) {
        if (i % 1000 === 0)
            wstream.write('\n');
        wstream.write('0x' + data[i].toString(16).padStart(2, '0') + (i < data.length - 1 ? ',' : ''));
    }
    wstream.write('\n};');
    wstream.end(cb);
}

// Task: Process assets (UI scripts, HTML, styles, images)
const process = (cb) => {
    console.log('PROCESS UI FILES TO FINAL: minify, merge, copy');
    // the stylesheet is our own (websrc/css), no framework
    const mergeCSS = () => merge(`${websrc}css/`, 'css', `${fnDir}`, `${mn}.css`);
    const minifyUIjs = (done) => bundleUI(`${websrc}js/`, `${fnDir}esprfid.js`, done);
    const minifyIndex = () => gulp.src(`${websrc}index.html`).pipe(htmlmin({ collapseWhitespace: true, minifyJS: true }).on('error', console.error)).pipe(gulp.dest(`${fnDir}`));
    // the page templates, one file per page in websrc/pages, served as one esprfid.htm
    const minifyPages = () => gulp.src(`${websrc}pages/*.htm`).pipe(concat({ path: 'esprfid.htm', stat: { mode: 0o666 } })).pipe(htmlmin({ collapseWhitespace: true }).on('error', console.error)).pipe(gulp.dest(`${fnDir}`));
    const minifyUIhtml = gulp.parallel(minifyIndex, minifyPages);
    const copyImages = (cb) => { fs.copy(`${websrc}img/`, `${fnDir}`, cb); };
    gulp.parallel(minifyUIjs, minifyUIhtml, mergeCSS, copyImages)(cb);
};

// Task: Gzip files
function gzipAll(cb) {
    console.log('GZIP FROM FINAL');
    const files = fs.readdirSync(fnDir);
    const tasks = files.map((file) => {
        const srcFile = path.join(fnDir, file);
        const destFile = path.join(gzDir, file + '.gz');
        const taskName = (done) => gzip(srcFile, destFile, done);
        Object.defineProperty(taskName, 'name', { value: `${file}.gz` });
        return taskName;
    });
    gulp.parallel(...tasks)(cb);
}

// Task: Create byte arrays from gzipped files
function byteArrayAll(cb) {
    console.log('BYTE ARRAY FROM GZIP');
    const files = fs.readdirSync(gzDir);
    const tasks = files.map(file => {
        const srcFile = path.join(gzDir, file);
        const destFile = `${webh}${file}.h`;
        const taskName = (done) => byteArray(srcFile, destFile, file, done);
        Object.defineProperty(taskName, 'name', { value: `${file}.h` });
        return taskName;
    });
    gulp.parallel(...tasks)(cb);
}

// Main runner function
function runner(cb) {
    gulp.series(ensureDirs, process, gzipAll, byteArrayAll)(cb);
}
exports.default = runner;