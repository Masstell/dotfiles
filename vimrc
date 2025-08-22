" Core
if has('syntax') | syntax on | endif
filetype plugin indent on

" Leader must be set before mappings/plugins
let mapleader = ","
" (optional) local leader too:
let maplocalleader = ","

" Remember last cursor position when reopening a file
if has('autocmd')
  augroup restore_cursor | autocmd!
    autocmd BufReadPost * if line("'\"") > 1 && line("'\"") <= line("$") |
          \ execute "normal! g'\"" | endif
  augroup END
endif

" ── UI ───────────────────────────────────────────────────────────────────────
set number                      " absolute line numbers
" set relativenumber            " (optional) hybrid numbers; <leader>rn toggles
set ruler                       " show cursor position
set showcmd                     " show partial commands
set laststatus=2                " always show statusline
set noshowmode                  " don't show -- INSERT -- when we have a statusline
set wrap                        " soft-wrap long lines
set scrolloff=5                 " keep context around cursor
set signcolumn=auto             " always show sign column (prevents jitter)

" NO underline: disable cursorline completely
set nocursorline
" …and make sure nobody re-enables underline by theme
if has('termguicolors') | set termguicolors | endif
highlight CursorLine cterm=NONE gui=NONE

" Colors (pick any built-in you like)
" colorscheme desert

" ── Files & backups ──────────────────────────────────────────────────────────
set encoding=utf-8
set fileencoding=utf-8

" Centralized dirs (create if missing)
silent! call mkdir($HOME.'/.vim/backups', 'p')
silent! call mkdir($HOME.'/.vim/undos',   'p')

set backup                      " keep backups
set backupdir=~/.vim/backups//
set undofile                    " persistent undo
set undodir=~/.vim/undos//
set noswapfile                  " skip swap files (we have backups/undo)

" ── Editing defaults ─────────────────────────────────────────────────────────
set tabstop=4
set shiftwidth=4
set expandtab
set smartindent
set autoindent
set shiftround                  " round indents to shiftwidth
set backspace=indent,eol,start
set textwidth=0                 " don't auto-wrap while typing
set formatoptions+=j            " remove comment leader when joining lines

" ── Searching ────────────────────────────────────────────────────────────────
set ignorecase
set smartcase
set incsearch
set hlsearch
set gdefault                    " :s/foo/bar/ affects all matches by default
nnoremap <leader>/ :nohlsearch<CR>

" ── Splits & navigation ─────────────────────────────────────────────────────
set splitbelow
set splitright
set hidden                      " switch buffers without saving
set updatetime=300              " faster CursorHold & swap/undo writes
set shortmess+=c                " fewer ins-completion messages

" ── Completion / UI niceties ────────────────────────────────────────────────
set wildmenu
set wildmode=longest:full,full
set completeopt=menuone,noinsert,noselect

" Show invisible characters (toggle with <leader>lc)
set list
set listchars=tab:»·,trail:·,extends:…,precedes:…,nbsp:␣
nnoremap <leader>lc :set list!<CR>

" Trim trailing spaces on write (but skip for markdown/markdown fenced code)
if has('autocmd')
  augroup trim_ws | autocmd!
    autocmd BufWritePre * if &ft !~# 'markdown' | silent! %s/\s\+$//e | endif
  augroup END
endif

" ── Clipboard (only if compiled with +clipboard) ────────────────────────────
if has('clipboard')
  set clipboard=unnamedplus
endif

" ── Statusline (lightweight, informative) ───────────────────────────────────
let &statusline = '%<%f %m%r%h%w%y%= [%{&fileencoding?&fileencoding:&encoding}/%{&fileformat}] %l:%c %p%%'

" ── Grep: use ripgrep if available ──────────────────────────────────────────
if executable('rg')
  set grepprg=rg\ --vimgrep\ --hidden\ --glob\ '!.git'
  set grepformat=%f:%l:%c:%m
endif

" ── Quality-of-life mappings ────────────────────────────────────────────────
let mapleader=" "
nnoremap <leader>w :update<CR>
nnoremap <leader>q :q<CR>
nnoremap <leader>bd :bdelete<CR>
nnoremap <leader>bn :bnext<CR>
nnoremap <leader>bp :bprevious<CR>

" ── NetRW (built-in file browser) sane defaults ─────────────────────────────
let g:netrw_banner=0
let g:netrw_browse_split=4
let g:netrw_liststyle=3
let g:netrw_winsize=25

