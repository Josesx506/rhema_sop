// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "bark-sidecar",
    platforms: [
        // FluidAudio's minimum. The Bark model itself needs macOS 15; the
        // sidecar checks that at runtime and reports a protocol error.
        .macOS(.v14)
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio", exact: "0.17.7")
    ],
    targets: [
        .executableTarget(
            name: "bark-sidecar",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ],
            path: "Sources/bark-sidecar"
        )
    ]
)
