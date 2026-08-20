CREATE TABLE clientes (
    id_cliente SERIAL PRIMARY KEY,

    nome VARCHAR(100) NOT NULL,
    email VARCHAR(100),
    telefone VARCHAR(20),

    sexo CHAR(20),

    estado_civil VARCHAR(20),

    data_nascimento DATE,

    data_cadastro DATE DEFAULT CURRENT_DATE
);

CREATE TABLE produtos (
    id_produto SERIAL PRIMARY KEY,

    nome VARCHAR(100) NOT NULL,

    categoria VARCHAR(50),

    preco NUMERIC(10,2) NOT NULL
	
);

CREATE TABLE vendas (
    id_venda SERIAL PRIMARY KEY,

    id_cliente INTEGER NOT NULL,

    data_venda DATE NOT NULL,

    valor_total NUMERIC(10,2),

    CONSTRAINT fk_venda_cliente
        FOREIGN KEY (id_cliente)
        REFERENCES clientes(id_cliente)
);

CREATE TABLE itens_venda (
    id_item SERIAL PRIMARY KEY,

    id_venda INTEGER NOT NULL,

    id_produto INTEGER NOT NULL,

    quantidade INTEGER NOT NULL,

    valor_unitario NUMERIC(9,2) NOT NULL,

    CONSTRAINT fk_item_venda
        FOREIGN KEY (id_venda)
        REFERENCES vendas(id_venda),

    CONSTRAINT fk_item_produto
        FOREIGN KEY (id_produto)
        REFERENCES produtos(id_produto)
);

CREATE TABLE servicos (
    id_servico SERIAL PRIMARY KEY,

    descricao VARCHAR(100) NOT NULL,

    valor NUMERIC(10,2) NOT NULL
);

CREATE TABLE atendimento_servico (
    id_atendimento SERIAL PRIMARY KEY,

    id_cliente INTEGER NOT NULL,

    id_servico INTEGER NOT NULL,

    data_atendimento DATE NOT NULL,

    valor_cobrado NUMERIC(10,2) NOT NULL,

    CONSTRAINT fk_atendimento_cliente
        FOREIGN KEY (id_cliente)
        REFERENCES clientes(id_cliente),

    CONSTRAINT fk_atendimento_servico
        FOREIGN KEY (id_servico)
        REFERENCES servicos(id_servico)
);