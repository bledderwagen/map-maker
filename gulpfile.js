var gulp = require('gulp');
var browserify = require('browserify');
var fancy_log = require('fancy-log');
var glob = require('glob');
var notify = require("gulp-notify");
var source = require('vinyl-source-stream');
var tsify = require('tsify');
var watchify = require('watchify');
var fs = require('fs');
var path = require('path');

var paths = {
    pages: ['src/html/*.html', 'src/html/*.css']
};

var babelconfig = {
    presets: ['@babel/preset-env'],
    extensions: ['.ts'],
};

var files = [];
var globFiles = glob.sync("./src/**/*.ts");
for (var i = 0; i < globFiles.length; i++) {
    files.push(globFiles[i]);
}

function createBrowserify(debug) {
    return browserify({
        basedir: '.',
        debug: debug,
        entries: files,
        cache: {},
        packageCache: {},
    })
        .plugin(tsify)
        .transform('babelify', babelconfig).on('error', fancy_log);
}

// Only created when running the default (watch) task
var watchedBrowserify;

gulp.task('copy-html', function () {
    return gulp.src(paths.pages)
        .pipe(gulp.dest('dist'));
});

gulp.task('apply-babelify-patch', function(done){
    // List of package.json files that need to be modified.
    var packages = ['node_modules/@svgdotjs/svg.js/package.json'];
    for(const i in packages) {

        // Split path into tokens and get an OS independent path.
        var pathTokens = packages[i].split('/');
        var filePath = path.join.apply(null, pathTokens);

        // Read file and parse JSON into an object.
        var jsonStr = fs.readFileSync(filePath);
        var pkg = JSON.parse(jsonStr);

        //Update the file with out custom browserify section.
        pkg['browserify'] = {
            "transform": [["babelify", { "presets": ["@babel/preset-env"] }]]
        };

        //Serialize the object back into a JSON string and write to file.
        jsonStr = JSON.stringify(pkg, null, 2);
        fs.writeFileSync(filePath, jsonStr);
    }
    //Signal that this task is complete.
    done();
});

function bundle() {
    if (!watchedBrowserify) {
        watchedBrowserify = watchify(createBrowserify(true));
        watchedBrowserify.on('update', bundle);
        watchedBrowserify.on('log', fancy_log);
    }
    return watchedBrowserify
        .bundle()
        .on('error', fancy_log)
        .pipe(source('bundle.js'))
        .pipe(gulp.dest('dist'))
        .pipe(notify("Done"));
}

// One-off production build, exits when done
function bundleOnce() {
    return createBrowserify(false)
        .bundle()
        .on('error', function (err) {
            fancy_log(err.message);
            process.exitCode = 1;
            this.emit('end');
        })
        .pipe(source('bundle.js'))
        .pipe(gulp.dest('dist'));
}

gulp.task('default', gulp.series(
    gulp.parallel('copy-html'),
    'apply-babelify-patch',
    bundle
));

gulp.task('build', gulp.series(
    gulp.parallel('copy-html'),
    'apply-babelify-patch',
    bundleOnce
));
