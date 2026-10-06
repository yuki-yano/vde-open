# ADR-0004: stdinを入力として扱う条件を、shellのpipeとredirectに限る

状態: 採用（P1）

## 背景

仕様5.1は、stdinがpipeで文書引数がないときはstdinから開くこと、pipeとpathの同時指定はerrorにすることを定める（CLI-007）。一方、Agentの実行環境ではstdinが端末でないことが多い。Claude CodeのBash実行やNodeの`child_process`から起動すると、stdinはsocketになる。`/dev/null`の場合はcharacter deviceになる。「端末でない」ことをpipeとみなすと、Agentが`vo open a.md`を実行するたびに「pipeとpathの併用」でerrorになる。

## 決定

stdinを「内容が渡されている」とみなすのは、FIFO（shellの`|`）か通常file（shellの`<`）のときだけにする。socket、character device、端末、閉じたstdinは入力として扱わない。`-`を明示したときは、種別にかかわらずstdinを読む。

- FIFO／通常fileで、pathがない → stdinから開く（`--format`が必要）。
- FIFO／通常fileで、pathもある → `E_INVALID_ARGUMENT`。
- それ以外で、pathがある → pathを開く。stdinは読まない。

## 影響

- socketで内容を渡す起動方法では、`-`を明示しないとstdinを読まない。
- 実行環境が意図せずFIFOをstdinに渡している場合は、pathを指定してもerrorになる。その場合は`< /dev/null`を付けて実行する。
