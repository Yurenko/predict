locals {
  secret_keys = [
    "DATABASE_URL",
    "REDIS_URL",
    "BINANCE_PAPER_API_KEY",
    "BINANCE_PAPER_API_SECRET",
    "BINANCE_PREDICTION_WALLET_ADDRESS",
  ]

  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "LIVE_TRADING_ENABLED", value = "false" },
    { name = "TRADING_MODE", value = "PAPER" },
    { name = "RAW_DATA_DIR", value = "/data/raw" },
    { name = "LOG_LEVEL", value = "info" },
    { name = "AWS_S3_RAW_BUCKET", value = aws_s3_bucket.raw.bucket },
  ]

  common_secrets = [
    for key in local.secret_keys : {
      name      = key
      valueFrom = "${aws_secretsmanager_secret.app.arn}:${key}::"
    }
  ]
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name      = "web"
    image     = var.web_image
    essential = true
    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]
    environment = local.common_env
    secrets     = local.common_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.web.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "web"
      }
    }
    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
  }])
}

resource "aws_ecs_task_definition" "worker_live" {
  family                   = "${var.name}-worker-live"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  volume {
    name = "raw"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.raw.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.raw.id
        iam             = "ENABLED"
      }
    }
  }
  container_definitions = jsonencode([{
    name      = "worker"
    image     = var.worker_image
    essential = true
    command   = ["npx", "tsx", "workers/src/index.ts", "collector:live"]
    environment = local.common_env
    secrets     = local.common_secrets
    mountPoints = [{
      sourceVolume  = "raw"
      containerPath = "/data/raw"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "live"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "worker_paper" {
  family                   = "${var.name}-worker-paper"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.exec.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name      = "worker"
    image     = var.worker_image
    essential = true
    command   = ["npx", "tsx", "workers/src/index.ts", "paper"]
    environment = local.common_env
    secrets     = local.common_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.worker.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "paper"
      }
    }
  }])
}

resource "aws_ecs_service" "web" {
  name            = "${var.name}-web"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.desired_web
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  depends_on = [
    aws_lb_listener.http_forward,
    aws_lb_listener.http_redirect,
    aws_lb_listener.https,
  ]
}

resource "aws_ecs_service" "worker_live" {
  name            = "${var.name}-live"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker_live.arn
  desired_count   = var.desired_live_workers
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }
  depends_on = [aws_efs_mount_target.raw, aws_efs_access_point.raw]
}

resource "aws_ecs_service" "worker_paper" {
  name            = "${var.name}-paper"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker_paper.arn
  desired_count   = var.desired_paper_workers
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }
}
