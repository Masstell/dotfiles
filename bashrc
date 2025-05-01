# mswensen's .bashrc file

# If not running interactively, don't do anything
[[ "$-" != *i* ]] && return

# Shell Options
#
# Use case-insensitive filename globbing
shopt -s nocaseglob
#
# ignore some typos
shopt -s cdspell
#
# Disable suspend
stty -ixon

# Completion options
#
# case-insensitive completion
bind "set completion-ignore-case on"
#
# show suggestions immediately
bind "set show-all-if-ambiguous on"
#
# show all suggestions
bind "set completion-query-items 0"

# History Options
#
# Don't put duplicate lines in the history.
export HISTCONTROL=$HISTCONTROL${HISTCONTROL+,}ignoredups
#
# Ignore some controlling instructions
export HISTIGNORE=$'[ \t]*:&:[fb]g:exit:ls:history:hist'
#
# Make bash append rather than overwrite the history on disk
shopt -s histappend

# Shell Options
#
# Use case-insensitive filename globbing
shopt -s nocaseglob
#
# ignore some typos
shopt -s cdspell
#
# Disable suspend
stty -ixon

# Completion options
#
# case-insensitive completion
bind "set completion-ignore-case on"
#
# show suggestions immediately
bind "set show-all-if-ambiguous on"
#
# show all suggestions
bind "set completion-query-items 0"

# History Options
#
# Don't put duplicate lines in the history.
export HISTCONTROL=$HISTCONTROL${HISTCONTROL+,}ignoredups
#
# Ignore some controlling instructions
export HISTIGNORE=$'[ \t]*:&:[fb]g:exit:ls:history:hist'
#
# Make bash append rather than overwrite the history on disk
shopt -s histappend

# Aliases
#
# override defaults
alias df='df -h'
alias du='du -h'
alias ls='ls -hN --color=tty --ignore="NTUSER.*" --ignore="ntuser.*"'
alias ll='ls -lA'
alias la='ls -A'
alias grep='grep -i --color=auto'
alias egrep='egrep --color=auto'
alias fgrep='fgrep --color=auto'
alias scp='__ssh_agent && scp'
alias ssh='__ssh_agent && ssh'
alias screen='screen -U' # always start screen in UTF-8 mode
alias sudo='sudo ' # expands other aliases when using sudo
#
# custom aliases
alias tunnel='ssh -fNL'
alias reload='source ~/.bashrc'
alias cls='printf "\033c"'
alias psh='ps -H'
alias ns='nslookup -nosearch -debug'
alias hist='history 20'
#
# git stuff
alias ga='git add'
alias gc='git commit -v'
alias gca='git commit -av'
alias gcm='git commit -m'
alias gd='git diff'
alias gds='git diff --staged'
alias gf='git fetch'
alias gg='git hist'
alias gs='git status -uno'

# conditional aliases
hash colordiff 2>/dev/null && alias diff=colordiff # use colordiff instead of diff if it exists
[ -f ~/.bash_aliases ] && source ~/.bash_aliases # load custom aliases if they exist

# other settings
hash vim 2>/dev/null && export EDITOR=$(which vim)
export TMOUT=0
[ -r ~/.ssh-agent ] && source ~/.ssh-agent >/dev/null
[ -r ~/.dircolors ] && eval "$(dircolors -b ~/.dircolors)" || eval "$(dircolors -b)"
[ -f ~/.git-completion.bash ] && source ~/.git-completion.bash # source git-completion if it exists
[ -f /etc/bash_completion ] && source /etc/bash_completion # source bash_completion if it exists

# custom functions

function __ssh_agent() {
    local agent_file="$HOME/.ssh-agent"

    # Check if agent is alive
    ssh-add -l >/dev/null 2>&1
    local result=$?

    if [ $result -eq 2 ]; then
        # Try restoring agent info
        if [ -f "$agent_file" ]; then
            source "$agent_file" >/dev/null 2>&1
            ssh-add -l >/dev/null 2>&1
            result=$?
        fi

        # Still broken? Start fresh agent
        if [ $result -eq 2 ]; then
            echo "Starting new ssh-agent..."
            local agent_output
            agent_output="$(ssh-agent -s)"
            echo "$agent_output" > "$agent_file"
            eval "$agent_output"
        fi
    fi

    # Add key if agent is running and no identities
    if ssh-add -l 2>&1 | grep -q "The agent has no identities"; then
        ssh-add
    fi
}


# check for dotfile updates & reload this file
[ ! -e ~/.dotfiles/.update_check ] && touch -t 197001010000 ~/.dotfiles/.update_check
if [[ $(( $(date +%s) - $(date +%s -r ~/.dotfiles/.update_check) )) -gt 28800 ]]; then
	echo Updating dotfiles...
	~/.dotfiles/update.sh
	touch ~/.dotfiles/.update_check
	source ~/.bashrc
fi
