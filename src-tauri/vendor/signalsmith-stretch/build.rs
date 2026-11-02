use std::path::Path;

fn main() {
    println!("cargo::rerun-if-changed=src/wrapper.h");
    println!("cargo::rerun-if-changed=src/wrapper.cpp");
    println!("cargo::rerun-if-changed=signalsmith-stretch/signalsmith-stretch.h");

    // MinGW (windows-gnu): libstdc++ linked statically, the computers the app is
    // installed on have no libstdc++-6.dll.
    let mingw = std::env::var("TARGET").is_ok_and(|t| t.ends_with("windows-gnu"));

    let mut build = cc::Build::new();
    build
        .file(Path::new("src").join("wrapper.cpp"))
        .include(Path::new("signalsmith-stretch"))
        .include(Path::new("."))
        .cpp(true)
        .std("c++14")
        .opt_level(3);
    if mingw {
        build.cpp_link_stdlib(None);
        let compiler = build.get_compiler();
        let out = std::process::Command::new(compiler.path())
            .arg("-print-file-name=libstdc++.a")
            .output()
            .expect("compilatore C++ di MinGW non avviato");
        let lib = std::path::PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        let dir = lib.parent().filter(|_| lib.is_absolute()).expect("libstdc++.a di MinGW non trovata");
        println!("cargo::rustc-link-search=native={}", dir.display());
        println!("cargo::rustc-link-lib=static:-bundle=stdc++");
    }
    build.compile("signalsmith-stretch");
}
