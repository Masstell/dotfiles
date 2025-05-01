" ~/.vimrc — Clean and Functional Starter Config

" BASIC UI
set number              " Show line numbers
set relativenumber      " Relative line numbers (great for jumping with motions)
set ruler               " Show cursor position
set showcmd             " Show incomplete commands
set cursorline          " Highlight current line
set laststatus=2        " Always show status line
set wrap                " Enable line wrapping

" Centralized directory for backups, swap, and undo
set backupdir=~/.vim/backups//
set directory=~/.vim/swaps//
set undodir=~/.vim/undos//

" FILE HANDLING
set encoding=utf-8
set fileencoding=utf-8
set backup              " Keep backup file
set undofile            " Persistent undo history
set noswapfile          " Disable swap file
set autoread            " Auto reload files changed outside Vim

" INDENTATION
set tabstop=4           " Number of spaces a <Tab> counts for
set shiftwidth=4        " Number of spaces for autoindent
set expandtab           " Use spaces instead of tabs
set smartindent         " Smart auto-indenting on new lines
set autoindent          " Copy indent from current line

" SEARCH
set ignorecase          " Case-insensitive search...
set smartcase           " ... unless search includes uppercase
set incsearch           " Show matches as you type
set hlsearch            " Highlight matches
nnoremap <Esc> :nohlsearch<CR> " Clear highlights on Escape

" TABS AND SPACES
set backspace=indent,eol,start " Make backspace behave more like other editors

" FILETYPE AND PLUGINS
filetype plugin indent on
syntax on

" COLORSCHEME
set termguicolors
colorscheme desert      " Change to 'elflord', 'murphy', etc., or install one

" VISUALS
set scrolloff=5         " Keep cursor 5 lines from top/bottom
set signcolumn=yes      " Always show signcolumn (useful with Git plugins)

" STATUSLINE (basic)
set statusline=%f\ %y\ %m\ %r%=%-14.(%l,%c%V%)\ %P

" CLIPBOARD (use system clipboard if available)
if has("clipboard")
  set clipboard=unnamedplus
endif

