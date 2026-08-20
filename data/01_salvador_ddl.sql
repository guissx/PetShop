-- Oracle DDL completo da Loja Salvador

CREATE TABLE categorias (
    id_categoria INT NOT NULL PRIMARY KEY,
    nome_categoria VARCHAR2(50) NOT NULL
);

CREATE TABLE clientes (
    id_cliente INT NOT NULL PRIMARY KEY,

    nome VARCHAR(50) NOT NULL,

    email VARCHAR(100),

    telefone VARCHAR(20),

    sexo CHAR(1)
        CHECK (sexo IN ('M', 'F')),

    estado_civil VARCHAR(1),

    data_nascimento DATE,

    data_cadastro DATE DEFAULT SYSDATE
);

CREATE TABLE produtos (
    id_produto INT NOT NULL  PRIMARY KEY,

    nome VARCHAR(50) NOT NULL,

    preco NUMERIC(10,2) NOT NULL,

    id_categoria INT NULL,

    CONSTRAINT fk_produto_categoria
        FOREIGN KEY (id_categoria)
        REFERENCES categorias(id_categoria)
);

CREATE TABLE vendas (
    id_venda INT NOT NULL  PRIMARY KEY,

    id_cliente INT NOT NULL,

    data_venda DATE NOT NULL,

    CONSTRAINT fk_venda_cliente
        FOREIGN KEY (id_cliente)
        REFERENCES clientes(id_cliente)
);

CREATE TABLE itens_venda (
    id_item INT NOT NULL PRIMARY KEY,

    id_venda INT NOT NULL,

    id_produto INT NOT NULL,

    quantidade INT NOT NULL,

    valor_unitario NUMERIC(10,2) NOT NULL,

    CONSTRAINT fk_item_venda
        FOREIGN KEY (id_venda)
        REFERENCES vendas(id_venda),

    CONSTRAINT fk_item_produto
        FOREIGN KEY (id_produto)
        REFERENCES produtos(id_produto)
);