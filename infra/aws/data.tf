resource "random_password" "db" {
  length  = 24
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "postgres" {
  identifier             = "${var.name}-pg"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = var.db_instance_class
  allocated_storage      = 20
  db_name                = "botpol"
  username               = "botpol"
  password               = random_password.db.result
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.data.id]
  skip_final_snapshot    = true
  publicly_accessible    = false
  storage_encrypted      = true
  deletion_protection    = false
}

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = var.name
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.data.id]
}

resource "aws_efs_file_system" "raw" {
  encrypted = true
  tags      = { Name = "${var.name}-raw" }
}

resource "aws_efs_mount_target" "raw" {
  count           = 2
  file_system_id  = aws_efs_file_system.raw.id
  subnet_id       = aws_subnet.private[count.index].id
  security_groups = [aws_security_group.data.id]
}

resource "aws_s3_bucket" "raw" {
  bucket_prefix = "${var.name}-raw-"
}

resource "aws_s3_bucket_public_access_block" "raw" {
  bucket                  = aws_s3_bucket.raw.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "raw" {
  bucket = aws_s3_bucket.raw.id
  rule {
    id     = "expire-raw"
    status = "Enabled"
    filter {
      prefix = ""
    }
    expiration {
      days = 90
    }
  }
}

resource "aws_efs_access_point" "raw" {
  file_system_id = aws_efs_file_system.raw.id
  posix_user {
    gid = 1000
    uid = 1000
  }
  root_directory {
    path = "/raw"
    creation_info {
      owner_gid   = 1000
      owner_uid   = 1000
      permissions = "755"
    }
  }
}

resource "aws_secretsmanager_secret" "app" {
  name = "${var.name}/app"
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DATABASE_URL                      = "postgresql://botpol:${random_password.db.result}@${aws_db_instance.postgres.address}:5432/botpol?schema=public"
    REDIS_URL                         = "redis://${aws_elasticache_cluster.redis.cache_nodes[0].address}:6379"
    BINANCE_PAPER_API_KEY             = var.binance_paper_api_key
    BINANCE_PAPER_API_SECRET          = var.binance_paper_api_secret
    BINANCE_PREDICTION_WALLET_ADDRESS = var.binance_prediction_wallet_address
  })
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.name}-web"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.name}-worker"
  retention_in_days = 14
}
