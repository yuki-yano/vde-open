{
  description = "vde-open development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { nixpkgs, ... }:
    let
      # CI の ubuntu-latest と macos-latest、開発機の Apple Silicon Mac を対象にする。Windows は Nix を使えない。
      systems = [ "aarch64-darwin" "x86_64-linux" ];
    in {
      devShells = nixpkgs.lib.genAttrs systems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          # shortcut: nixpkgs の nodejs_24 は 24.22.2 まで。24.22.3 が入ったら nodejs_24 へ戻す。
          nodePlatform = {
            aarch64-darwin = {
              name = "darwin-arm64";
              sha256 = "1d64136c8a43d648d1b3bad10797a4c995b1ca032d2bde8799de43b37f058fe5";
            };
            x86_64-linux = {
              name = "linux-x64";
              sha256 = "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb";
            };
          }.${system};
          # npm も同梱の版を使う（scripts/lib.ts の pack 検証と publish.yml の npm publish）。
          nodejs = pkgs.stdenvNoCC.mkDerivation rec {
            pname = "nodejs";
            version = "24.22.3";
            src = pkgs.fetchurl {
              url = "https://nodejs.org/dist/v${version}/node-v${version}-${nodePlatform.name}.tar.xz";
              inherit (nodePlatform) sha256;
            };
            nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib ];
            dontStrip = true;
            installPhase = "mkdir -p $out; cp -R . $out/";
          };
        in {
          # package.json の engines.node と packageManager は、ここで入る版に合わせる（pnpm run check:runtime で確かめる）。
          default = pkgs.mkShellNoCC {
            packages = [ nodejs pkgs.pnpm_12 ];
          };
        });
    };
}
