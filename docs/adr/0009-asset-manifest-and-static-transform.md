# ADR-0009: assetは文書が実際に参照するfileだけを登録し、HTMLは構文木で静的な表示へ変換する

状態: 採用（P3）

## 背景

仕様10.3は、`--assets-root`を「解決できる範囲の上限」とし、その中のfileをすべて公開することを禁じる。仕様10.4は、HTMLの文字列への正規表現だけのsanitizeを禁じ、構文解析を求める。

## 決定

### assetの登録

- 登録時に、HTMLの`src`・`srcset`・stylesheet・`style`、CSSの`url()`・`@import`、Markdownの画像を構文解析して、参照先を集める。解析は別threadで行う。
- 参照は、assets-rootからの相対path（logical path）へ解決する。rootの外を指すもの、`file:`、UNC、`\`を含むもの、区切りやNULをencodeしたもの、二重にencodeしたものは拒否する。`/`で始まる参照は、filesystemの絶対pathではなく、assets-rootからの指定として扱う。
- 読むのは、symlinkを解決した結果がrootの中にある通常のfileだけ。解決の前後と読み取りの前後で、同じfileを指していることを確かめる。別のprocessが同時にpathを差し替える攻撃を、完全に防ぐものではない。
- 登録できるかの検査（`.`で始まる名前、種別）は、symlinkを解決した後の実体にも適用する。画像の名前を付けたsymlinkで、`.env`や別の種類のfileを読ませない。
- 種別は拡張子で決める（PNG・JPEG・WebP・GIF・AVIF・SVG、CSS、WOFF・WOFF2、JS・MJS、JSON）。名前が`.`で始まるfileやdirectoryの下は登録しない。JSONは`--asset`で個別に指定したものだけ。
- 上限は、1つ20MiB、1文書の合計100MiB、500個、CSSの読み込みの深さ8。超える文書は登録しない。互いを読み込むCSSは、読み込み済みのpathを記録して止める。
- 文書の版は、本文に加えて、登録したassetのpath・種別・内容のhashから計算する。CSSだけが変わっても版が変わる。
- assetの変更も監視する。参照されているが存在しないfileも追い、作られたら取り込む。
- assets-rootの指定がなければ、fileは親directory、stdinはlocal assetなし。開き直すときに指定がなければ、登録済みの設定を使う。`--watch`のruleは登録時のassets-rootを保持し、後から見つけた文書にも使う。assets-rootのない文書への`--asset`はerrorにする。
- 参照の走査が、時間切れや構造の上限で終わらなかった場合は、「参照がない」とは区別して記録する。調べ終えたassetを持つ文書の更新で走査に失敗したら、新しい版を公開せず、前の版・asset・変更を追うfileを保って、状態をerrorにする（fileが変わるか、手動で読み直すと、もう一度調べる）。新しく開く文書は、assetなしで登録して警告を返し、表示にもその旨を出す。走査に失敗した結果では、途中まで集めたassetを使わず、追うfileと照合用の状態も文書だけにする。stdinの文書は、同じkeyの更新を1件ずつ行う。

### 静的な表示への変換

- parse5で構文木にし、木を書き換えてから出力する。scriptを動かさない前提で解析する（`scriptingEnabled: false`）。既定の設定では`noscript`の中身が文字として素通りし、取り除く対象から漏れる。
- 取り除くもの: `script`、event属性、`iframe`・`object`・`embed`などの埋め込み、`base`、`meta http-equiv`、先読みの指定、formの送信先、`ping`・`download`・`target`・`srcdoc`、文書に直接書かれたSVGとMathML、コメント。`noscript`は外して中身を残す。
- linkは、文書内の移動だけを残して無効にし、本体の一覧から開けるようにする。localの文書へのlinkは、IDで指定し、未登録なら利用者の確認を経てから開く。
- 確認は、serverが発行する識別子で、確認した文書・版・link・行き先に結び付ける。1回だけ使え、5分で切れる。確認の後で文書が更新されたり、assets-rootが変わったりして行き先が変わっていたら、新しい行き先を示して確認し直す。開くのは、確認した行き先そのもの。
- 画像とstylesheetは、登録済みのものだけを残す。CSSはcss-treeの構文木で調べ、許可されない`url()`・`@import`を含む宣言を取り除く。構文木にできない部分は無効化する。
- 何を取得するかを判定できないCSSは無効化する。名前をescapeで書いた規則・宣言・関数（`@\69mport`など。browserは別の名前として解釈する）と、変数などから値を差し込む関数（`var()`・`env()`・`attr()`）を、URLを受け取る関数（`image-set()`など）へ渡す宣言が該当する。
- 出力をもう一度解析し、実行や遷移につながる要素・属性が残っていたら、変換を失敗させる。
- 取り除いたものは、種類と対象ごとに記録し、本体の画面に理由と対処を表示する。

## 影響

- 文書に直接書いたSVGは表示されない。SVGをfileにして`<img>`で参照すれば表示できる。
- scriptが実行時に読み込むfileや、scriptが作る内容は、静的な表示には現れない。
- css-treeは、本体のentryが構文dataをfilesystemから読むため、解析・走査・出力の単体entry（`css-tree/parser`・`walker`・`generator`）を使う。
