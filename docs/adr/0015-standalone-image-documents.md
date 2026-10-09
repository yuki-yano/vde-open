# ADR-0015: 単体画像は元のbytesを持つ独立した文書形式にする

画像を直接開くため、`DocumentFormat`に`image`を追加する。画像をMarkdownやHTMLに包むと、原文・title・sourceのsize・保存監視が生成文書の性質に引きずられるため、元のbytesを版のsourceとして保存する。既存の登録・一覧・順序・監視・質問への版固定・restart復元をそのまま使い、表示の権限では対象画像だけを画像のMIME type付きで配信する。

表示は別originの配信URLを`<img>`へ渡し、browserのdecoderに任せる。画像の変換やdecoderの依存は追加しない。SVGも画像assetとして扱い、assetのCSPを維持する。未対応の形式と壊れたfileは表示のerrorにする。検索はtitleとpathだけを対象とし、OCR・原文・見出し・節・PDF出力は提供しない。

認識する拡張子はPNG/APNG、JPEGの各表記、GIF、WebP、AVIF、SVG、BMP、ICO/CUR、JPEG XL、TIFF、HEIC/HEIF。MIMEと拡張子は文書内assetの判定とも共有する。形式の認識と、利用中のbrowserで実際に描画できることは別に扱う。

## DoD

### 機能完了条件

- [x] `vo image.png`、directory、globで画像を登録し、元のbytesを配信する。
- [x] 画像の版を保存し、atomic save・削除後の復元・daemon再起動を扱う。
- [x] 画面に収まる表示・原寸表示・更新の一時停止・表示errorを用意する。
- [x] 画像のtitleとpathを検索し、文字の読み取りとPDF出力は明示的に拒否する。

### テスト完了条件

- [x] 結合テストでMIME・bytes・他fileの404・close後の無効化・版固定・restart・検索・size上限を確認する。
- [x] DOMテストで画像のload／errorまでの切り替え待ち、更新の一時停止、質問の版固定を確認する。
- [x] ブラウザで複数の実画像・原寸表示・更新・壊れた画像・SVGの外部参照遮断を確認する。
- [x] format・lint・typecheck・画像のunit／integration・build・packが成功する。
- [x] repository全体のunit／integrationが成功する。

### 運用反映条件

- [x] linked CLIをbuildし、開いている文書と並び順を保ってdaemonへ反映する。
- [x] README・Agent guide・同梱skillで対応形式と文字読み取りの制限を説明する。

検証（2026-10-09）: format・lint・typecheckと全体のunit／integration 912件が成功。画像の結合6件とDOM4件、既存WorkspaceのDOM28件を含む。ChromiumのE2Eは93件、Firefox／WebKitは102件が成功（6件は既定のskip）。切替中の旧画像と新画像を区別するようテストの対象指定を修正し、画像のE2Eは3browserの12件すべてが成功した。pack smokeでも、空の導入先から画像を開き、元のbytesとMIMEが保たれることを確認した。React Doctorは未追跡の追加fileを含め、HEADとの差分に新しい指摘なし。

linked CLIのdaemonを再起動し、8文書のIDと並び順を維持して反映した。認証なしの管理APIがHTTP 200を返し、配信されるUIに画像表示の操作が含まれることを確認した。npmへの公開は、version tagのpushを起点に既存のGitHub Actionsで行う。

初回の検証では、実行環境の`fs.watch`が`EMFILE`を返し、browserの起動も拒否された。公開前の再検証では、ファイル監視を含む全体チェックとPlaywrightによる実ブラウザの描画・操作が成功し、この未検証項目を解消した。
