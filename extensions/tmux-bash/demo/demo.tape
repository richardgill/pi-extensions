Require pi
Require tmux

Set Shell "bash"
Set FontSize 24
Set Width 1400
Set Height 900
Set Padding 24
Set Framerate 30
Set TypingSpeed 35ms
Set WindowBar ColorfulRight
Set Theme "tokyonight"

Hide
Type 'pi() { command pi --no-extensions --no-skills "$@"; }'
Enter
Type 'clear'
Enter
Show

Type@20ms 'pi -e "npm:@richardgill/pi-tmux-bash"'
Enter
Sleep 2s


Type@20ms 'Run: echo "hello from tmux"'
Enter
Sleep 4s

Type@20ms 'Run: sleep 5 && echo "finished" in background.'
Enter
Sleep 8s

Type@20ms 'Run: for i in $(seq 1 30); do echo "$i"; sleep 1; done. In background, poll every 10s.'
Enter
Sleep 35s

