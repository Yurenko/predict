output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "ecs_cluster" {
  value = aws_ecs_cluster.this.name
}

output "raw_bucket" {
  value = aws_s3_bucket.raw.bucket
}

output "secrets_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "migrate_command" {
  value = "aws ecs run-task --cluster ${aws_ecs_cluster.this.name} --launch-type FARGATE --task-definition ${aws_ecs_task_definition.worker_paper.family} --network-configuration \"awsvpcConfiguration={subnets=[${aws_subnet.public[0].id}],securityGroups=[${aws_security_group.ecs.id}],assignPublicIp=ENABLED}\" --overrides '{\"containerOverrides\":[{\"name\":\"worker\",\"command\":[\"npx\",\"prisma\",\"migrate\",\"deploy\"]}]}'"
}
