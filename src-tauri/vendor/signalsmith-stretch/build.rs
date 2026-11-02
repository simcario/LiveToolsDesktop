use std::path::Path;

fn main() {
    println!("cargo::rerun-if-changed=src/wrapper.h");
    println!("cargo::rerun-if-changed=src/wrapper.cpp");
    println!("cargo::rerun-if-changed=signalsmith-stretch/signalsmith-stretch.h");

    cc::Build::new()
        .file(Path::new("src").join("wrapper.cpp"))
        .include(Path::new("signalsmith-stretch"))
        .include(Path::new("."))
        .cpp(true)
        .std("c++14")
        .opt_level(3)
        .compile("signalsmith-stretch");
}
