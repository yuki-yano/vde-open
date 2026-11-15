# ADR-0017: 選択肢の説明と推奨は質問定義に持ち、回答panelで表示だけする

状態: 採用。

## 背景

Agentが人に判断を求めるとき、選択肢の値だけでは、人は各案の違いとAgentの推奨を文書の中から探すことになる。回答panelで、選択肢ごとの説明とAgentの推奨を、選ぶ前に比べられるようにする。

ただし、推奨を初期選択にすると、人が確かめないまま推奨が送信されうる。回答の値の形を変えると、Agentの側の読み方も変わる。

## 決定

- 単一選択（`type: "string"`と`enum`）に、任意の`enumDescriptions`と`recommended`を足す。`enumDescriptions`は、`enum`と同じ長さの文字列の配列。各要素は2000文字以内で、空文字は説明なしを表す。名前と形はVS Codeの設定schemaの`enumDescriptions`に合わせ、新しい名前を作らない。`recommended`は`enum`の値の1つ。
- 複数選択（`type: "array"`と`items.enum`）では、説明を`items.enumDescriptions`に、推奨を`recommended`（値の配列）に書く。推奨は、そのfieldへの回答と同じ形にする。
- 検証は`questionnaireSchema`（Zod）で行う。2つのkeyは、`enum`があるfieldにだけ指定できる。`enumDescriptions`の長さが選択肢の数と違えば拒否する。`recommended`は既存の回答の検証（`validateAnswers`の送信時の検証）に通し、選択肢に含まれること、重複がないこと、`minLength`・`maxLength`・`minItems`・`maxItems`を守ることを確かめる。拒否は`E_QUESTIONNAIRE_INVALID`で、issueのpathは該当のfieldかkeyを指す。質問定義の全体の64KiBの上限は変えない。
- 同梱のmeta-schema（`packages/shared/schemas/questionnaire.schema.json`）と`tests/fixtures/handoff/questionnaire.schema.json`にも、同じkeyと上限を足す。Zodとの一致はcontract testで確かめる。
- 回答panelのラジオとチェックボックスでは、選択肢名の下に「Recommended」の文字と説明を縦に並べる。この2つはlabelの外に置き、`aria-describedby`でcontrolと結ぶ。accessible nameは選択肢名のまま。推奨は色ではなく文字で示す。
- 選択肢が7件以上でselectになる単一選択では、推奨のoptionに「(Recommended)」を付ける。optionには説明を出せないので、説明のある選択肢と推奨の選択肢をselectの下に一覧で出す（説明のない推奨も、selectを開かずに見えるようにする）。複数選択は件数によらずチェックボックス。
- 推奨は回答案に書き込まず、初期選択にもしない。回答の値は、選んだ`enum`の文字列のまま。
- 回答panelに画像は出さない。図は文書（HTMLと登録した画像）に置く。panelに画像を入れると、表示の権限と管理UIの安全性の境界に触れるため。

## 影響

- Agentの側の回答の読み方は変わらない。2つのkeyは任意なので、既存の質問定義と保存済みの質問はそのまま読める。
- 説明は質問定義の64KiBに含まれる。選択肢が多く説明が長い質問は、上限に届きやすい。
- interactiveのHTMLは、`vde.ready()`の`questionnaire`で2つのkeyも受け取る。
- 推奨を初期選択にする手段は作らない。選ぶ操作は人に残す。

## DoD

### 機能完了条件

- [x] 単一選択と複数選択で`enumDescriptions`と`recommended`を受け付け、不正な指定を`E_QUESTIONNAIRE_INVALID`で拒否する。
- [x] 回答panelのラジオ・チェックボックス・selectで説明と推奨を表示し、推奨を初期選択にしない。
- [x] `docs/agent-usage.md`・`docs/agent-usage.ja.md`・`skills/vde-open/SKILL.md`に書き方と規則を記載する。

### テスト完了条件

- [x] contract testで、受け付ける形と拒否する指定（enumのないfield、説明の数の不一致、2000文字超の説明、無効な`recommended`）と、meta-schemaとの一致を確かめる。
- [x] DOM testとe2eで、説明と「Recommended」がcontrolのaccessible descriptionになること、selectの下の説明の一覧、推奨が初期選択にも回答案にもならないこと、回答の値が選んだ`enum`の文字列であることを確かめる。
- [x] `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e tests/e2e/feedback.spec.ts`がexit 0。
- [x] sandboxのdaemonで3種類の質問を作り、回答panelを撮影して表示を確かめる。不正な定義がCLIで`E_QUESTIONNAIRE_INVALID`になることを確かめる。

検証（2026-11-15）: `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`（79 files、919件）、`pnpm build`、`pnpm test:e2e tests/e2e/feedback.spec.ts`（4件）が成功。専用の`VDE_OPEN_HOME`で起動したdaemonに、6件以下の単一選択、8件の単一選択（select）、複数選択の3つの質問を`ask --view`で作り、Playwrightのchromiumで回答panelを撮影した。説明と「Recommended」、selectの下の説明の一覧が表示され、どの質問も未選択・未回答のままだった。説明の数の不一致、`enum`にない`recommended`、`enum`のないfieldへの指定は、いずれも`E_QUESTIONNAIRE_INVALID`（終了コード2）になり、質問は登録されなかった。
